/**
 * #703 — the assembly rules of reranking, all at once before any model call: `keep` and
 * `candidates` whole numbers with `1 ≤ keep ≤ candidates`, `by` a `@Reranker`, its name's suffix, a
 * code reranker's `rerank()`, a model reranker on a chat model served by the application's providers.
 */
import { describe, expect, it } from "vitest";
import { Agent, DecidedBy, EmptyEnvironment, Workflow, type Class } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { createApp } from "../../src/application/create-app.js";
import {
  Rag,
  RagMode,
  RagTenancy,
  Reranker,
  type RagConnector,
  type RagRetrieval,
} from "../../src/rag/index.js";
import { workflowOf } from "../../src/testing/index.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { starOf } from "../fixtures/test-flow/star.js";
import { testDefaults } from "../helpers.js";

class Empty implements RagConnector {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

@Reranker({ name: "docs-reranker", description: "On the default model" })
class DefaultModelReranker {}

@Reranker({ name: "docs-ranker", description: "Wrong suffix", model: "local/llama" })
class BadNameReranker {}

@Reranker({ name: "jev-reranker", description: "A decision model", model: "typesafe/jev-1.13" })
class DecisionReranker {}

// a JS project, or a cast: a code reranker without rerank()
@Reranker({
  name: "empty-reranker",
  description: "No rerank()",
  decidedBy: DecidedBy.Code,
} as never)
class NoHandlerReranker {}

class NotAReranker {
  readonly isReranker = false;
}

function workflowReading(by: Class, counts = { candidates: 10, keep: 3 }): Class {
  @Rag({
    name: "docs-rag",
    description: "Docs",
    tenancy: RagTenancy.PerTenant,
    rerank: { by, ...counts },
  })
  class DocsRag extends Empty {}
  @Agent({
    name: "reader-agent",
    description: "Reads",
    prompt: "Read.",
    model: "local/llama",
    rag: [{ use: DocsRag, mode: RagMode.Tool }],
  })
  class ReaderAgent {}
  @Workflow({
    name: "reader-workflow",
    version: "1.0.0",
    defaults: testDefaults,
    flow: starOf(ReaderAgent),
  })
  class ReaderWorkflow {}
  return ReaderWorkflow;
}

const codesOf = async (workflow: Class): Promise<readonly string[]> => {
  const failed = await workflowOf(workflow).catch((e: unknown) => e);
  const violations = (failed as { violations?: readonly { code: string }[] }).violations ?? [];
  return violations.map((v) => v.code);
};

describe("#703: reranking at assembly", () => {
  it.each([
    [{ candidates: 3, keep: 5 }, "keep above candidates"],
    [{ candidates: 10, keep: 0 }, "keep 0"],
    [{ candidates: 2.5, keep: 1 }, "candidates not whole"],
  ])("[rag.rerank-invalid]: %j (%s)", async (counts) => {
    expect(await codesOf(workflowReading(DefaultModelReranker, counts))).toContain(
      "rag.rerank-invalid",
    );
  });

  it("[rag.not-a-reranker], [name.kind-suffix], [reranker.decision-model], [reranker.missing-handler]", async () => {
    expect(await codesOf(workflowReading(NotAReranker))).toEqual(["rag.not-a-reranker"]);
    expect(await codesOf(workflowReading(BadNameReranker))).toEqual(["name.kind-suffix"]);
    expect(await codesOf(workflowReading(DecisionReranker))).toEqual(["reranker.decision-model"]);
    expect(await codesOf(workflowReading(NoHandlerReranker))).toEqual(["reranker.missing-handler"]);
  });

  it("describe: k is keep, the reranker, the candidates and the failure policy", async () => {
    const bundle = await workflowOf(workflowReading(DefaultModelReranker));

    expect(describeWorkflow(bundle)).toContain(
      "    rag: docs-rag (tool, k 3, per-tenant, reranked by docs-reranker from 10, on failure fallback)",
    );
    expect(bundle.rerankers).toEqual([{ name: "docs-reranker", model: "openai/gpt-4.1-nano" }]);
  });

  it("[model.unserved]: the default model under providers that do not serve it names rerankers.<name>", async () => {
    @Application({
      name: "local-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [workflowReading(DefaultModelReranker)],
      providers: MODEL_PROVIDERS,
      budgets: TEST_BUDGETS,
    })
    class LocalApplication {}

    const failed = await createApp(LocalApplication, {
      gateway: createScriptedGateway(new ScriptBook()),
    }).catch((e: unknown) => e);

    expect((failed as Error).message).toContain("rerankers.docs-reranker = openai/gpt-4.1-nano");
  });
});
