/**
 * #708 — the core's LLM reranker reads the query and the candidates as the reading agent's own
 * model reads them: through that agent's PII policies (here the agent's alone — the application has
 * none), with its execution's sensitive values, in tool mode and in context mode. An address
 * reaches the reranker's model as a token, in a candidate's text and in its source (AC1); the
 * reranked passage still reaches the agent as retrieved, its own boundary masking it as before
 * (AC2); a block rule in a candidate refuses as it would in the agent's own model — the tool call
 * refused, the execution refused — and the reranker's model reads nothing. The trace of the
 * reranking (its span and its model call) holds the masked text only.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { boundRerankerOf, knowledgeRetrieveOf, ragMeta } from "../../src/components/rag.js";
import { gatherKnowledge } from "../../src/graph/nodes/knowledge.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { modelReadingMaskOf, withModelReading } from "../../src/pii/model-reading.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { componentOf } from "../../src/components/metadata.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";
import type { RagConnector } from "../../src/rag/index.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { ToolCallTurn } from "../../src/testing/turns.js";
import type { Class } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { inTestFrame } from "../helpers/frame.js";
import { requestText, tokensIn } from "../pii/boundary.helpers.js";
import {
  CARD,
  CARDS_CONTEXT,
  CARDS_TOOL,
  EMAIL,
  PEOPLE_CONTEXT,
  PEOPLE_TOOL,
  PeopleRag,
  PII_KEY_VARIABLE,
  RerankPiiApplication,
  USER_ID,
} from "./fixtures/rerank-pii.application.js";

const QUESTION = "Who do I write to about on-call?";
const RANKING = '{"ranking":[1,3,2]}';
const RERANKER = "reranker:people-reranker";
const search = (rag: string): ToolCallTurn => ({
  kind: "tool-call",
  tool: `search-${rag}-tool`,
  args: { query: "on-call swaps" },
});

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWith(book: ScriptBook): Promise<App> {
  app = await createApp(RerankPiiApplication, {
    processEnv: { [PII_KEY_VARIABLE]: "test-key" },
    gateway: createScriptedGateway(book),
  });
  return app;
}

const run = async (book: ScriptBook, start: Class) =>
  execute(await appWith(book), start, { text: QUESTION }, { execution: { userId: USER_ID } });

/** The token the address became in a candidate's text ("Write to <email:…>"). */
const textToken = (read: string): string | undefined =>
  /Write to (<email:[0-9a-f]+>)/u.exec(read)?.[1];

/** What the reranker's model read, as one text. */
const rerankerRead = (book: ScriptBook): string => requestText(book.scriptOf(RERANKER).lastRequest);

describe("#708 AC1: the reranker's model reads the candidates through the agent's PII policies", () => {
  it.each([
    ["tool mode", PEOPLE_TOOL, "agent:people-tool-agent", [search("people-rag"), replyWith("ok")]],
    ["context mode", PEOPLE_CONTEXT, "agent:people-context-agent", [replyWith("ok")]],
  ] as const)(
    "%s: an address as a token in the text and the source, the sensitive user id hidden",
    async (_mode, flow, agent, turns) => {
      const book = new ScriptBook();
      book.scriptOf(RERANKER).thenReturn(replyWith(RANKING));
      book.scriptOf(agent).thenReturn(...turns);

      await run(book, flow.start);

      const read = rerankerRead(book);
      expect(read).not.toContain(EMAIL);
      expect(read).not.toContain(USER_ID);
      // the address in the text and the one in the source (`…@example.com.md`) both tokens
      expect(textToken(read)).toBeDefined();
      expect(tokensIn(read, "email")).toHaveLength(2);
      expect(read).toMatch(/\[1\] \(people\/<email:[0-9a-f]+>\) Write to <email:[0-9a-f]+> for/u);
      // the ranking still orders the passages as retrieved: the rota is second
      expect(read).toContain("[3] (rota.md) On-call starts after the third month.");
    },
  );
});

describe("#708 AC2: the reranked passages reach the agent unchanged", () => {
  it("tool mode: the tool's result holds the address; the agent's model reads the same token", async () => {
    const book = new ScriptBook();
    book.scriptOf(RERANKER).thenReturn(replyWith(RANKING));
    book
      .scriptOf("agent:people-tool-agent")
      .thenReturn(search("people-rag"), replyWith("Write to them."));

    const result = await run(book, PEOPLE_TOOL.start);

    const output = JSON.stringify(result.toolCalls[0]?.output);
    expect(output).toContain(`Write to ${EMAIL} for on-call swaps.`);
    expect(output.indexOf("people/")).toBeLessThan(output.indexOf("rota.md"));
    const agentRead = requestText(book.scriptOf("agent:people-tool-agent").lastRequest);
    expect(agentRead).not.toContain(EMAIL);
    expect(textToken(agentRead)).toBe(textToken(rerankerRead(book)));
  });

  it("context mode: the knowledge block in the reranked order, masked by the agent as before", async () => {
    const book = new ScriptBook();
    book.scriptOf(RERANKER).thenReturn(replyWith(RANKING));
    book.scriptOf("agent:people-context-agent").thenReturn(replyWith("Write to them."));

    await run(book, PEOPLE_CONTEXT.start);

    const agentRead = requestText(book.scriptOf("agent:people-context-agent").lastRequest);
    expect(agentRead).not.toContain(EMAIL);
    const token = textToken(rerankerRead(book));
    expect(agentRead).toContain(`Write to ${String(token)} for on-call swaps.`);
    expect(agentRead.indexOf("Write to")).toBeLessThan(agentRead.indexOf("third month"));
  });
});

describe("#708: a block rule in a candidate follows the rule of what the agent reads", () => {
  it("tool mode: the call is refused as a tool result would be, the reranker's model reads nothing", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:cards-tool-agent")
      .thenReturn(search("cards-rag"), replyWith("I cannot read that."));

    const result = await run(book, CARDS_TOOL.start);

    expect(book.scriptOf(RERANKER).requests).toHaveLength(0);
    const agentRead = requestText(book.scriptOf("agent:cards-tool-agent").lastRequest);
    expect(agentRead).toContain(
      "Tool error: the call was refused: Please do not send a card-number.",
    );
    expect(agentRead).not.toContain(CARD);
    expect(result.toolCalls[0]?.output).toBeUndefined();
  });

  it("context mode: the execution is refused (PiiRefusedError), the reranker's model reads nothing", async () => {
    const book = new ScriptBook();

    const refused = await run(book, CARDS_CONTEXT.start).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PiiRefusedError);
    expect(refused).toMatchObject({ refusal: "Please do not send a card-number." });
    expect(book.scriptOf(RERANKER).requests).toHaveLength(0);
  });
});

describe("#708: the reranking's trace holds the masked text only", () => {
  const seen: string[] = [];
  class Recorder extends BaseCallbackHandler {
    name = "recorder";
    override handleChainStart(
      ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
    ): void {
      if (args[7]?.startsWith("rerank:") === true)
        seen.push(`${args[7]} ${JSON.stringify(args[1])}`);
    }
    override handleChatModelStart(_llm: unknown, messages: BaseMessage[][]): void {
      seen.push(JSON.stringify(messages.flat().map((message) => message.content)));
    }
  }

  it("the span rerank:<name> and its model call carry the token, never the address", async () => {
    seen.length = 0;
    const meta = ragMeta(PeopleRag);
    const services = {
      router: () => ({ name: "r", route: () => Promise.reject(new Error("unused")) }),
      rerankModel: () => ({
        model: new FakeListChatModel({ responses: [RANKING] }),
        settings: {
          model: "test/reranker",
          temperature: 0,
          maxTokens: 256,
          price: { inputPerMTok: 1, outputPerMTok: 2 },
        },
      }),
    };
    const reranker = boundRerankerOf(meta, (cls) => new (cls as new () => unknown)(), services);
    const connector = new (PeopleRag as new () => RagConnector)();
    const source = {
      name: meta.name,
      topK: 3,
      retrieve: knowledgeRetrieveOf(meta, connector, reranker),
    };
    const set = contactPolicies();
    const query = `Ask ${EMAIL} or someone else?`;

    await inTestFrame(() =>
      withModelReading(modelReadingMaskOf(set), () =>
        gatherKnowledge([source], query, { callbacks: [new Recorder()] }),
      ),
    );

    expect(seen).toHaveLength(2);
    for (const entry of seen) {
      expect(entry).not.toContain(EMAIL);
      expect(entry).toMatch(/<email:[0-9a-f]{6,}>/u);
    }
  });
});

/** The contact policy as a set, as an agent's loop holds it (a fixed key, no model). */
function contactPolicies(): PiiPolicySet {
  const component = componentOf(ContactPiiPolicy);
  if (component?.kind !== "pii-policy") throw new Error("not a policy");
  const meta: PiiPolicyMeta = component.meta;
  const policy = runtimePolicyOf({ meta, instance: new ContactPiiPolicy(), key: "k" });
  return new PiiPolicySet([policy], "field-key");
}
