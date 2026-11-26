/**
 * The assembly rules of reranking, all at once before any model call: `reranker.candidates` and
 * `@Rag({ topK })` whole numbers with `1 ≤ topK ≤ candidates` (`[rag.rerank-invalid]`), `reranker` a
 * `@RagReranker` (`[rag.not-a-reranker]`), its name kebab-case, a model reranker's model from its
 * provider (`[model.missing]`, `[model.missing-provider]`) — and no default model of the core's own.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Agent, Workflow, type Class, inline, Ttl } from "../../src/index.js";
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
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

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

function workflowReading(reranker: Class, topK = 3, workflowProvider = true): Class {
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
    prompt: inline("Read."),
    model: "local/llama",
    modelProvider: TestModelProvider,
    rag: [DocsRag],
  })
  class ReaderAgent {}
  @Workflow({
    name: "reader-workflow",
    ...(workflowProvider ? { modelProvider: TestModelProvider } : {}),
    version: "1.0.0",
    historyTtl: Ttl.Forever,
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
    expect(bundle.rerankers).toEqual([
      { name: "docs-reranker", model: "local/llama", modelProvider: "test-model-provider" },
    ]);
  });

  it("a model reranker that names no model, under no model provider: [model.missing-provider] — the core has no default model", async () => {
    expect(await codesOf(workflowReading(NoModelReranker, 3, false))).toEqual([
      "model.missing-provider",
    ]);
  });
});

describe("#1299: @RagReranker({ prompt }) is read at assembly", () => {
  it("a model reranker's inline prompt is on the assembled workflow", async () => {
    @RagReranker({
      name: "prompted-reranker",
      description: "Prompted",
      candidates: 10,
      model: "local/llama",
      prompt: inline("  Prefer the newest documents.\n"),
    })
    class PromptedReranker {}

    const bundle = await workflowOf(workflowReading(PromptedReranker));

    expect(bundle.rerankers).toEqual([
      {
        name: "prompted-reranker",
        model: "local/llama",
        modelProvider: "test-model-provider",
        prompt: "  Prefer the newest documents.",
      },
    ]);
  });

  it("a bare text is [prompt.bare-text], not a prompt", async () => {
    @RagReranker({
      name: "bare-reranker",
      description: "Bare",
      candidates: 10,
      model: "local/llama",
      prompt: "Prefer the newest documents." as never,
    })
    class BareReranker {}

    await expect(workflowOf(workflowReading(BareReranker))).rejects.toThrow("[prompt.bare-text]");
  });
});
