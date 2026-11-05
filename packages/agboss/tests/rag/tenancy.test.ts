/**
 * #796 — a knowledge base declares whose content it serves: `@Rag({ tenancy })`, `PerTenant` (the
 * execution's tenant's passages only, #700) or `Shared` (one corpus every tenant may read). The
 * type requires it (`compile-time.test.ts`); a JS project or a cast without it, or with another
 * value, is `[rag.tenancy-required]` at assembly. `describe` prints it, and `describe --json` and
 * the `configHash` carry it: shared content is a reviewed choice, never a connector's silence.
 */
import { describe, expect, it } from "vitest";
import { Agent, Workflow, type Class } from "../../src/index.js";
import { describeServices, describeWorkflow } from "../../src/describe/describe-workflow.js";
import { workflowSnapshotOf } from "../../src/describe/snapshot.js";
import {
  Rag,
  RagMode,
  RagTenancy,
  type RagConnector,
  type RagRetrieval,
} from "../../src/rag/index.js";
import { workflowOf } from "../../src/testing/index.js";
import { starOf } from "../fixtures/test-flow/star.js";
import { testDefaults } from "../helpers.js";

class Empty implements RagConnector {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

/** A workflow whose agent searches a knowledge base declared with `options` (as a JS caller may). */
function workflowReading(options: object): Class {
  @Rag({ name: "policy-rag", description: "Policies", topK: 2, ...options } as never)
  class PolicyRag extends Empty {}
  @Agent({
    name: "reader-agent",
    description: "Reads",
    prompt: "Read.",
    model: "local/llama",
    rag: [{ use: PolicyRag, mode: RagMode.Tool }],
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

const violationsOf = async (workflow: Class) => {
  const failed = await workflowOf(workflow).catch((e: unknown) => e);
  return (failed as { violations?: readonly { code: string; message: string }[] }).violations;
};

describe("#796: a knowledge base's tenancy is declared", () => {
  it.each([
    ["none", {}],
    ["undefined", { tenancy: undefined }],
    ["another value", { tenancy: "per_tenant" }],
    ["a boolean", { tenancy: true }],
  ])("[rag.tenancy-required]: %s", async (_, options) => {
    const violations = await violationsOf(workflowReading(options));

    expect(violations).toEqual([
      {
        code: "rag.tenancy-required",
        message: expect.stringContaining(
          "policy-rag: declare whose content it serves — tenancy: RagTenancy.PerTenant",
        ) as unknown,
        nodes: ["policy-rag"],
      },
    ]);
  });

  it.each([
    [RagTenancy.PerTenant, "per-tenant"],
    [RagTenancy.Shared, "shared"],
  ])("describe prints %s; describe --json carries it", async (tenancy, printed) => {
    const bundle = await workflowOf(workflowReading({ tenancy }));
    const agent = workflowSnapshotOf(bundle, describeServices).nodes.find(
      (node) => node.name === "reader-agent",
    );

    expect(describeWorkflow(bundle)).toContain(`    rag: policy-rag (tool, k 2, ${printed})`);
    expect(agent?.agent?.rag).toEqual([{ name: "policy-rag", mode: "tool", topK: 2, tenancy }]);
  });

  it("the configHash tells a shared knowledge base from a tenant's own", async () => {
    const hashOf = async (tenancy: RagTenancy): Promise<string> =>
      workflowSnapshotOf(await workflowOf(workflowReading({ tenancy })), describeServices)
        .configHash;

    expect(await hashOf(RagTenancy.Shared)).not.toBe(await hashOf(RagTenancy.PerTenant));
  });
});
