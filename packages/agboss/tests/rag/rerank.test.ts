/**
 * #703 — reranking on `@Rag({ rerank })`: the agent gets the reranked best `topK` of `candidates`,
 * in tool and in context mode (AC1); the reranker's spend is in the turn's cost and its budgets
 * (AC2); a failing reranker falls back to the retrieval's order with a trace, or fails the step under
 * `FailStep` (AC3); a reranking that is no subset of the candidates is a failure (isolation).
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Budget, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import { BudgetExceededError } from "../../src/index.js";
import { boundRerankerOf, knowledgeRetrieveOf, ragMeta } from "../../src/components/rag.js";
import { gatherKnowledge } from "../../src/graph/nodes/knowledge.js";
import type { RagConnector } from "../../src/rag/index.js";
import type { KnowledgeSource } from "../../src/rag/types.js";
import { inTestFrame } from "../helpers/frame.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { ToolCallTurn } from "../../src/testing/turns.js";
import { usd, type Usd } from "../../src/units/index.js";
import type { Class } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  ANSWER,
  FALLBACK_CONTEXT,
  FallbackRankedRag,
  ModelRankedRag,
  INVENTING_CONTEXT,
  KEYWORD_TOOL,
  MODEL_CONTEXT,
  MODEL_TOOL,
  rerankApplication,
  STRICT_CONTEXT,
  STRICT_TOOL,
} from "./fixtures/rerank.application.js";

const QUESTION = "When does on-call start?";
const search = (rag: string): ToolCallTurn => ({
  kind: "tool-call",
  tool: `search-${rag}-tool`,
  args: { query: "on-call start" },
});
/** The model reranker's reply: candidate 27 (the answer) first, then 1 and 2. */
const RANKING = '{"ranking":[27,1,2]}';

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWith(book: ScriptBook, application: Class = rerankApplication()): Promise<App> {
  app = await createApp(application, { gateway: createScriptedGateway(book) });
  return app;
}

/** The sources of the first tool call's results. */
const sourcesOf = (output: unknown): readonly string[] =>
  ((output as { results?: readonly { source: string }[] } | undefined)?.results ?? []).map(
    (result) => result.source,
  );

describe("#703 AC1: the agent gets the reranked best topK of the candidates", () => {
  it("tool mode, model reranker: the 27th candidate, ranked first, reaches the agent first; topK 3", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING));
    book
      .scriptOf("agent:model-tool-agent")
      .thenReturn(search("model-ranked-rag"), replyWith("done"));

    const result = await execute(await appWith(book), MODEL_TOOL.start, { text: QUESTION });

    expect(sourcesOf(result.toolCalls[0]?.output)).toEqual([
      ANSWER.source,
      "near-miss-0.md",
      "near-miss-1.md",
    ]);
    const asked = requestText(book.scriptOf("reranker:docs-reranker").lastRequest);
    expect(asked).toContain(`[27] (${ANSWER.source}) ${ANSWER.text}`);
  });

  it("context mode, model reranker: the knowledge block starts with the reranked first", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));

    await execute(await appWith(book), MODEL_CONTEXT.start, { text: QUESTION });

    const sent = requestText(book.scriptOf("agent:model-context-agent").lastRequest);
    expect(sent).toContain(`Knowledge (model-ranked-rag):\n[${ANSWER.source}] ${ANSWER.text}`);
    expect(sent).not.toContain("near-miss-2.md");
  });

  it("tool mode, code reranker: its own order, its reported cost billed to rag:<name>", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:keyword-tool-agent")
      .thenReturn(search("keyword-ranked-rag"), replyWith("done"));

    const result = await execute(await appWith(book), KEYWORD_TOOL.start, { text: QUESTION });

    expect(sourcesOf(result.toolCalls[0]?.output)[0]).toBe(ANSWER.source);
    expect(result.spend.byCategory.retrieval).toBeCloseTo(0.0001 + 0.0004, 10);
  });
});

describe("#703 AC2: the reranker's cost is in the turn and counts against the budgets", () => {
  it("context mode: the model reranker's call is a retrieval line under rag:<name> on its model", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING, { cost: usd(0.002) }));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));

    const result = await execute(await appWith(book), MODEL_CONTEXT.start, { text: QUESTION });

    expect(result.spend.byCategory.retrieval).toBeCloseTo(0.0001 + 0.002, 10);
    expect(result.spend.trace).toContainEqual(
      expect.objectContaining({
        caller: "rag:model-ranked-rag",
        model: "local/llama",
        category: "retrieval",
      }),
    );
  });

  it("tool mode: the model reranker's call is in the tool call's spend", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING, { cost: usd(0.003) }));
    book
      .scriptOf("agent:model-tool-agent")
      .thenReturn(search("model-ranked-rag"), replyWith("done"));

    const result = await execute(await appWith(book), MODEL_TOOL.start, { text: QUESTION });

    expect(result.spend.byCategory.retrieval).toBeCloseTo(0.0001 + 0.003, 10);
  });
});

describe("#703 AC3: a failing reranker", () => {
  it("default: the retrieval's own first topK, the turn goes on", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:fallback-context-agent").thenReturn(replyWith("done"));

    const result = await execute(await appWith(book), FALLBACK_CONTEXT.start, { text: QUESTION });

    expect(result.status).toBe(ExecutionStatus.Finished);
    const sent = requestText(book.scriptOf("agent:fallback-context-agent").lastRequest);
    expect(sent).toContain("[near-miss-0.md]");
    expect(sent).toContain("[near-miss-2.md]");
    expect(sent).not.toContain("near-miss-3.md");
  });

  it("an inventing reranker is a failure: the invented passage never reaches the agent", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:inventing-context-agent").thenReturn(replyWith("done"));

    await execute(await appWith(book), INVENTING_CONTEXT.start, { text: QUESTION });

    const sent = requestText(book.scriptOf("agent:inventing-context-agent").lastRequest);
    expect(sent).not.toContain("plum");
    expect(sent).toContain("[near-miss-0.md]");
  });

  it.each([
    ["tool mode", STRICT_TOOL, [search("strict-ranked-rag"), replyWith("never")]],
    ["context mode", STRICT_CONTEXT, [replyWith("never")]],
  ] as const)(
    "FailStep, %s: the step fails with RerankFailedError (step.rerank-failed)",
    async (_mode, flow, turns) => {
      const book = new ScriptBook();
      book
        .scriptOf(`agent:${flow === STRICT_TOOL ? "strict-tool" : "strict-context"}-agent`)
        .thenReturn(...turns);

      const failed = await execute(await appWith(book), flow.start, { text: QUESTION }).catch(
        (error: unknown) => error,
      );

      const chain: unknown[] = [];
      for (let e: unknown = failed; e instanceof Error; e = e.cause) chain.push(e);
      expect(chain.map((e) => (e as { code?: string }).code)).toContain("step.rerank-failed");
    },
  );
});

@Budget({ name: "tiny-execution-budget", scope: BudgetScope.Execution })
class TinyExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.001);
  }
}

describe("#703 AC2: the reranker's spend counts against the execution's budget", () => {
  it("a reranking that costs more than the budget stops the execution before the agent's model", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith(RANKING, { cost: usd(0.002) }));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));
    const budgets = [TestApplicationDailyBudget, TestTenantDailyBudget, TinyExecutionBudget];

    const stopped = await execute(
      await appWith(book, rerankApplication(budgets)),
      MODEL_CONTEXT.start,
      {
        text: QUESTION,
      },
    ).catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(BudgetExceededError);
    expect(book.scriptOf("agent:model-context-agent").requests).toHaveLength(0);
  });
});

describe("#703 AC2, AC3: the trace", () => {
  const names: string[] = [];
  let chatModels = 0;
  class Recorder extends BaseCallbackHandler {
    name = "recorder";
    override handleChainStart(
      ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
    ): void {
      names.push(args[7] ?? "");
    }
    override handleChatModelStart(): void {
      chatModels += 1;
    }
  }
  const services = {
    router: () => ({ name: "r", route: () => Promise.reject(new Error("unused")) }),
  };
  const sourceOf = (rag: Class, reply = RANKING): KnowledgeSource => {
    const meta = ragMeta(rag);
    const reranker = boundRerankerOf(meta, (cls) => new (cls as new () => unknown)(), {
      ...services,
      rerankModel: () => ({
        model: new FakeListChatModel({ responses: [reply] }),
        settings: {
          model: "test/reranker",
          temperature: 0,
          maxTokens: 256,
          price: { inputPerMTok: 1, outputPerMTok: 2 },
        },
      }),
    });
    const connector = new (rag as new () => RagConnector)();
    return {
      name: meta.name,
      topK: meta.topK,
      retrieve: knowledgeRetrieveOf(meta, connector, reranker),
    };
  };

  it("a reranking is a span rerank:<name> inside rag:<name>, its model call inside it", async () => {
    names.length = 0;
    chatModels = 0;

    const { records } = await inTestFrame(() =>
      gatherKnowledge([sourceOf(ModelRankedRag)], QUESTION, { callbacks: [new Recorder()] }),
    );

    expect(names).toEqual(
      expect.arrayContaining(["rag:model-ranked-rag", "rerank:model-ranked-rag"]),
    );
    expect(chatModels).toBe(1);
    expect(records.map((r) => r.caller)).toEqual(["rag:model-ranked-rag", "rag:model-ranked-rag"]);
  });

  it("AC3: a fallback is a span rerank:<name>:fallback after the failed rerank:<name>", async () => {
    names.length = 0;

    await inTestFrame(() =>
      gatherKnowledge([sourceOf(FallbackRankedRag)], QUESTION, { callbacks: [new Recorder()] }),
    );

    expect(names).toEqual(
      expect.arrayContaining(["rerank:fallback-ranked-rag", "rerank:fallback-ranked-rag:fallback"]),
    );
  });
});
