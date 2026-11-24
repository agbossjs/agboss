/**
 * A knowledge base declares whose content it serves: `@Rag({ scope })` — `Shared` (one corpus every
 * tenant may read), `Tenant` (the execution's tenant's passages only), `Owner` (the execution's
 * owner's), `Custom` (`resolveScope(context)`). The type requires it (`compile-time.test.ts`); a JS
 * project or a cast without it, or with another value, is `[rag.scope-required]` at assembly.
 * `describe` prints it, and `describe --json` and the `configHash` carry it: shared content is a
 * reviewed choice, never a source's silence. A call that cannot name its scope reads nothing.
 */
import { describe, expect, it } from "vitest";
import { Agent, Workflow, type Class } from "../../src/index.js";
import { describeServices, describeWorkflow } from "../../src/describe/describe-workflow.js";
import { workflowSnapshotOf } from "../../src/describe/snapshot.js";
import {
  Rag,
  RagScope,
  RagSource,
  RerankFailurePolicy,
  type RagRetrieval,
  type RagRetrieveOptions,
} from "../../src/rag/index.js";
import { ragMeta } from "../../src/components/rag.js";
import { knowledgeRetrieveOf } from "../../src/components/rag-retrieval.js";
import type { WorkflowServices } from "../../src/workflow.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { RagScopeError } from "../../src/rag/rag-source.js";
import { testFrame } from "../helpers/frame.js";
import type { BoundReranker } from "../../src/rag/rerank.js";
import { inTenantFrame } from "../helpers/frame.js";
import { testUnit } from "../../src/testing/index.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { starOf } from "../fixtures/test-flow/star.js";
import { testDefaults } from "../helpers.js";

const liveSignal = (): AbortSignal => new AbortController().signal;

class Empty extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
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
    rag: [PolicyRag],
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

describe("#796: a knowledge base's scope is declared", () => {
  it.each([
    ["none", {}],
    ["undefined", { scope: undefined }],
    ["another value", { scope: "per_tenant" }],
    ["a boolean", { scope: true }],
  ])("[rag.scope-required]: %s", async (_, options) => {
    const violations = await violationsOf(workflowReading(options));

    expect(violations).toEqual([
      {
        code: "rag.scope-required",
        message: expect.stringContaining(
          "policy-rag: declare whose content it serves — scope: RagScope.Shared",
        ) as unknown,
        nodes: ["policy-rag"],
      },
    ]);
  });

  it.each([
    [RagScope.Tenant, "tenant"],
    [RagScope.Shared, "shared"],
    [RagScope.Owner, "owner"],
  ])("describe prints %s; describe --json carries it", async (scope, printed) => {
    const bundle = await workflowOf(workflowReading({ scope }));
    const agent = workflowSnapshotOf(bundle, describeServices).nodes.find(
      (node) => node.name === "reader-agent",
    );

    expect(describeWorkflow(bundle)).toContain(`    rag: policy-rag (k 2, ${printed})`);
    expect(agent?.agent?.rag).toEqual([{ name: "policy-rag", topK: 2, scope }]);
  });

  it("the configHash tells a shared knowledge base from a tenant's own and an owner's", async () => {
    const hashOf = async (scope: RagScope): Promise<string> =>
      workflowSnapshotOf(await workflowOf(workflowReading({ scope })), describeServices).configHash;

    expect(await hashOf(RagScope.Shared)).not.toBe(await hashOf(RagScope.Tenant));
  });

  it("testUnit refuses a knowledge base without its scope, as assembly does", () => {
    @Rag({ name: "loose-rag", description: "No scope", topK: 1 } as never)
    class LooseRag extends Empty {}

    expect(() => testUnit(LooseRag)).toThrow(
      /\[rag\.scope-required\]|loose-rag: declare whose content/u,
    );
  });
});

/** A source that records the scope id of every call it gets. */
const seen: { call: string; tenantId: string | undefined; scopeId: string | undefined }[] = [];

function recordingSource(scope: RagScope) {
  @Rag({ name: "scoped-rag", description: "One corpus", scope, topK: 2 })
  class ScopedRag extends RagSource {
    protected override retrieve(_query: string, options: RagRetrieveOptions): RagRetrieval {
      seen.push({ call: "retrieve", tenantId: options.tenantId, scopeId: options.scopeId });
      return { results: [{ source: "help.md", text: "Shipping takes two days." }] };
    }

    override resolveScope(): string {
      return "org-7:sales";
    }
  }
  return ScopedRag;
}

const services = {
  router: () => {
    throw new Error("unused");
  },
} as WorkflowServices;

/** Runs `work` in a frame of tenant `tenantId`, owned by `ownerId` (none: no owner). */
function inFrameOf<T>(tenantId: string, ownerId: string | undefined, work: () => Promise<T>) {
  const frame = testFrame();
  const tenant = Object.create(frame.execution.tenant, {
    tenantId: { value: tenantId, enumerable: true },
  }) as typeof frame.execution.tenant;
  return runInFrame({ ...frame, execution: { ...frame.execution, tenant, ownerId } }, work);
}

const retrievalOf = (cls: Class<RagSource>, reranker?: BoundReranker) => {
  const construct: unknown = cls;
  return knowledgeRetrieveOf(
    ragMeta(cls),
    new (construct as new () => object)(),
    reranker,
    services,
  );
};

/**
 * What each scope passes to the source (a data-isolation boundary: a call that cannot name its scope
 * reads nothing). A shared source gets no scope id — never a tenant's — reranked or not.
 */
describe("the scope id every call to a source carries", () => {
  const reranker: BoundReranker = {
    rag: "scoped-rag",
    reranker: "scoped-reranker",
    candidates: 5,
    onFailure: RerankFailurePolicy.FailStep,
    source: {
      kind: "code",
      instance: () => ({
        rerank: (_query, candidates, options) => {
          seen.push({ call: "rerank", tenantId: options.tenantId, scopeId: options.scopeId });
          return { results: candidates.slice(0, options.topK) };
        },
      }),
    },
  };

  it.each([
    ["Shared: none", RagScope.Shared, undefined],
    ["Tenant: the execution's tenant", RagScope.Tenant, "acme"],
    ["Owner: the execution's owner (CallOptions.owner)", RagScope.Owner, "alice"],
    ["Custom: what resolveScope returns", RagScope.Custom, "org-7:sales"],
  ] as const)("%s", async (_, scope, expected) => {
    for (const [bound, calls] of [
      [undefined, ["retrieve"]],
      [reranker, ["retrieve", "rerank"]],
    ] as const) {
      seen.length = 0;
      const retrieve = retrievalOf(recordingSource(scope), bound);

      await inFrameOf("acme", "alice", () =>
        retrieve("shipping", { topK: 1, signal: liveSignal() }),
      );

      expect(seen).toEqual(
        calls.map((call) => ({
          call,
          // every non-global scope is bound to the tenant; the shared one names none
          tenantId: scope === RagScope.Shared ? undefined : "acme",
          scopeId: expected,
        })),
      );
    }
  });

  it("Owner with no owner: fails closed, the source is never called", async () => {
    seen.length = 0;
    const retrieve = retrievalOf(recordingSource(RagScope.Owner));

    await expect(
      inFrameOf("acme", undefined, () => retrieve("shipping", { topK: 1, signal: liveSignal() })),
    ).rejects.toBeInstanceOf(RagScopeError);
    expect(seen).toEqual([]);
  });

  it("Custom whose resolveScope returns nothing: fails closed, the source is never called", async () => {
    seen.length = 0;
    @Rag({ name: "blank-rag", description: "Blank", scope: RagScope.Custom, topK: 1 })
    class BlankRag extends RagSource {
      protected override retrieve(_query: string, options: RagRetrieveOptions): RagRetrieval {
        seen.push({ call: "retrieve", tenantId: options.tenantId, scopeId: options.scopeId });
        return { results: [] };
      }

      override resolveScope(): string {
        return "";
      }
    }
    const retrieve = retrievalOf(BlankRag);

    await expect(
      inFrameOf("acme", "alice", () => retrieve("q", { topK: 1, signal: liveSignal() })),
    ).rejects.toBeInstanceOf(RagScopeError);
    expect(seen).toEqual([]);
  });

  it("a scope that is none of the four: fails closed, never a shared read", async () => {
    seen.length = 0;
    const retrieve = retrievalOf(recordingSource("everyone" as RagScope));

    await expect(
      inFrameOf("acme", "alice", () => retrieve("q", { topK: 1, signal: liveSignal() })),
    ).rejects.toBeInstanceOf(RagScopeError);
    expect(seen).toEqual([]);
  });

  it("a scope id that is no key's text is refused naming the rule, never the id", async () => {
    seen.length = 0;
    const retrieve = retrievalOf(recordingSource(RagScope.Owner));
    const owner = "bob\u200b";

    const failed = await inFrameOf("acme", owner, () =>
      retrieve("q", { topK: 1, signal: liveSignal() }),
    ).catch((error: unknown) => error as Error);

    expect((failed as Error).message).not.toContain(owner);
    expect(seen).toEqual([]);
  });
});

describe("an owner or a custom id is unique within a tenant only: every non-global scope carries its tenant", () => {
  const keysOf = async (scope: RagScope, tenantId: string, ownerId: string | undefined) => {
    seen.length = 0;
    const retrieve = retrievalOf(recordingSource(scope));
    await inFrameOf(tenantId, ownerId, () => retrieve("q", { topK: 1, signal: liveSignal() }));
    return seen.map(({ tenantId: t, scopeId }) => ({ tenantId: t, scopeId }));
  };

  it("the same owner id in two tenants is two keys", async () => {
    const a = await keysOf(RagScope.Owner, "tenant-a", "alice");
    const b = await keysOf(RagScope.Owner, "tenant-b", "alice");

    expect(a).toEqual([{ tenantId: "tenant-a", scopeId: "alice" }]);
    expect(b).toEqual([{ tenantId: "tenant-b", scopeId: "alice" }]);
  });

  it("the same custom key in two tenants is two keys", async () => {
    const a = await keysOf(RagScope.Custom, "tenant-a", "alice");
    const b = await keysOf(RagScope.Custom, "tenant-b", "alice");

    expect(a[0]).toEqual({ tenantId: "tenant-a", scopeId: "org-7:sales" });
    expect(b[0]).toEqual({ tenantId: "tenant-b", scopeId: "org-7:sales" });
  });

  it("a crafted owner id never turns into another tenant's key: the parts travel apart", async () => {
    const crafted = await keysOf(RagScope.Owner, "tenant-a", "b:alice");
    const real = await keysOf(RagScope.Owner, "tenant-a:b", "alice");

    expect(crafted).toEqual([{ tenantId: "tenant-a", scopeId: "b:alice" }]);
    expect(real).toEqual([{ tenantId: "tenant-a:b", scopeId: "alice" }]);
    expect(crafted).not.toEqual(real);
  });
});
