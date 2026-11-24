/**
 * The assembly rules of reranking, all at once before any model call: `reranker.candidates` and
 * `@Rag({ topK })` whole numbers with `1 ≤ topK ≤ candidates` (`[rag.rerank-invalid]`), `reranker` a
 * `@RagReranker` (`[rag.not-a-reranker]`), its name kebab-case, a model reranker's model from its
 * provider (`[model.missing]`, `[model.missing-provider]`) — and no default model of the core's own.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Agent, EmptyEnvironment, Workflow, type Class } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { Rag, RagReranker, RagScope, RagSource, type RagRetrieval } from "../../src/rag/index.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { starOf } from "../fixtures/test-flow/star.js";
import { testDefaults } from "../helpers.js";

class Empty extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }
}

@RagReranker({
  name: "docs-reranker",
  description: "On a named model",
  candidates: 10,
  model: "local/llama",
})
class NamedModelReranker {}

@RagReranker({ name: "no-model-reranker", description: "Names no model", candidates: 10 })
class NoModelReranker {}

@RagReranker({
  name: "Docs_Ranker",
  description: "Not kebab-case",
  candidates: 10,
  model: "local/llama",
})
class BadNameReranker {}

class NotAReranker {
  readonly isReranker = false;
}

function workflowReading(reranker: Class, topK = 3): Class {
  @Rag({
    name: "docs-rag",
    description: "Docs",
    scope: RagScope.Tenant,
    topK,
    // a JS caller's `reranker` may be any class: the assembly refuses what the type does
    reranker,
  })
  class DocsRag extends Empty {}
  @Agent({
    name: "reader-agent",
    description: "Reads",
    prompt: "Read.",
    model: "local/llama",
    rag: [DocsRag],
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

/** A reranker that fetches `candidates`, named by them. */
function rerankerOfCount(candidates: number): Class {
  @RagReranker({
    name: "counted-reranker",
    description: "Counted",
    candidates,
    model: "local/llama",
  })
  class CountedReranker {}
  return CountedReranker;
}

describe("reranking at assembly", () => {
  it.each([
    [{ candidates: 3, topK: 5 }, "topK above candidates"],
    [{ candidates: 10, topK: 0 }, "topK 0"],
    [{ candidates: 2.5, topK: 1 }, "candidates not whole"],
  ])("[rag.rerank-invalid]: %j (%s)", async ({ candidates, topK }) => {
    expect(await codesOf(workflowReading(rerankerOfCount(candidates), topK))).toContain(
      "rag.rerank-invalid",
    );
  });

  it("[rag.not-a-reranker], [name.not-kebab-case]", async () => {
    expect(await codesOf(workflowReading(NotAReranker))).toEqual(["rag.not-a-reranker"]);
    expect(await codesOf(workflowReading(BadNameReranker))).toEqual(["name.not-kebab-case"]);
  });

  it("describe: k is topK, the reranker, the candidates and the failure policy (fail the step by default)", async () => {
    const bundle = await workflowOf(workflowReading(NamedModelReranker));

    expect(describeWorkflow(bundle)).toContain(
      "    rag: docs-rag (k 3, tenant, reranked by docs-reranker from 10, on failure fail-step)",
    );
    expect(bundle.rerankers).toEqual([{ name: "docs-reranker", model: "local/llama" }]);
  });

  it("a model reranker that names no model, under no model provider: [model.missing-provider] — the core has no default model", async () => {
    expect(await codesOf(workflowReading(NoModelReranker))).toEqual(["model.missing-provider"]);
  });
});
