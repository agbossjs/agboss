/**
 * #1366 (ledger-retention shard) — what a knowledge base's file settles besides its search spend, each rule on its
 * own over fakes: the classes an agent binds or a tool injects are @Rag classes (named when not, a duplicate refused),
 * the config entries describe and `configHash` read (the top-k, the scope, the reranking's candidates and failure
 * policy), the models a reranker is given, the scope every retrieval is made for (never another one), and the
 * reranker bound to a knowledge base — a model one refused without a gateway — with the retrieval that runs through it.
 */
import { ValidationError } from "../../src/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkedRagClassesOf,
  contextSources,
  ragClassesOf,
  ragMeta,
  ragSettings,
  rerankerClassesOf,
} from "../../src/components/rag.js";
import { boundRerankerOf, rerankerModelsOf } from "../../src/components/rag-reranker.js";
import { knowledgeRetrieveOf } from "../../src/components/rag-retrieval.js";
import { scopeKeyOfRetrieval } from "../../src/components/rag-scope.js";
import { ComponentError, componentOf, requireComponent } from "../../src/components/metadata.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { checkRags } from "../../src/rag/rag-checks.js";
import { RagScopeError, retrieveOf } from "../../src/rag/rag-source.js";
import { rerankedRetrieval } from "../../src/rag/rerank.js";
import { RagScope, RerankFailurePolicy } from "../../src/rag/types.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../src/models/index.js";
import { seconds } from "../../src/units/index.js";

vi.mock("../../src/components/metadata.js", async (original) => ({
  ...(await original<typeof import("../../src/components/metadata.js")>()),
  componentOf: vi.fn(),
  requireComponent: vi.fn(),
}));
vi.mock("../../src/flow/context/frame.js", () => ({ currentFrame: vi.fn() }));
vi.mock("../../src/rag/rag-checks.js", () => ({ checkRags: vi.fn() }));
vi.mock("../../src/rag/rerank.js", () => ({ rerankedRetrieval: vi.fn() }));
vi.mock("../../src/rag/rag-source.js", async (original) => ({
  ...(await original<typeof import("../../src/rag/rag-source.js")>()),
  retrieveOf: vi.fn(() => Promise.resolve({ results: [] })),
}));

class JobsRag {
  readonly kind = "jobs";
}
class DocsRag {
  readonly kind = "docs";
}
class ModelReranker {
  readonly kind = "model";
}
class CodeReranker {
  readonly kind = "code";
  rerank(): void {
    return undefined;
  }
}
class NotAReranker {
  readonly kind = "none";
}
class SearchTool {
  readonly kind = "tool";
}

/** The metas of each test, made afresh: a test changes the ones it needs. */
let rerankerMeta: Record<string, object> = {};
let ragMetas: Record<string, object> = {};
let toolMetas: Record<string, object> = {};
const freshMetas = (): void => {
  rerankerMeta = {
    [ModelReranker.name]: { name: "model-reranker", candidates: 20, model: "cheap" },
    [CodeReranker.name]: { name: "code-reranker", candidates: 7 },
  };
  ragMetas = {
    [JobsRag.name]: { name: "jobs-rag", topK: 5, scope: RagScope.Tenant },
    [DocsRag.name]: { name: "docs-rag", topK: 3, scope: RagScope.Shared, reranker: ModelReranker },
  };
  toolMetas = { [SearchTool.name]: { name: "search", deps: [JobsRag, "a-token"] } };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(retrieveOf).mockResolvedValue({ results: [] });
  freshMetas();
  vi.mocked(componentOf).mockImplementation(((cls: { name: string }) => {
    if (cls.name in ragMetas) return { kind: "rag", meta: ragMetas[cls.name] };
    if (cls.name in rerankerMeta) return { kind: "reranker", meta: rerankerMeta[cls.name] };
    if (cls.name in toolMetas) return { kind: "tool", meta: toolMetas[cls.name] };
    return cls.name === NotAReranker.name ? { kind: "agent", meta: {} } : undefined;
  }) as never);
  vi.mocked(requireComponent).mockImplementation(((cls: { name: string }) => ({
    kind: "rag",
    meta: ragMetas[cls.name],
  })) as never);
});

const agentOf = (name: string, ...rag: object[]) => ({ name, rag }) as never;
const workflow = { name: "w" } as never;

describe("#1366: the knowledge bases of a workflow", () => {
  it("are the @Rag classes of its agents' rag and of its tools' deps, each once", () => {
    const agents = [agentOf("a", JobsRag, DocsRag), agentOf("b", JobsRag)];

    expect(ragClassesOf(workflow, agents)).toEqual([JobsRag, DocsRag]);
    expect(ragClassesOf(workflow, [{ name: "bare" } as never])).toEqual([]);
    expect(ragClassesOf(workflow, [agentOf("a", DocsRag)], [SearchTool as never])).toEqual([
      DocsRag,
      JobsRag,
    ]);
  });

  it("a class that is no @Rag is refused by name, naming the workflow", () => {
    expect(() => ragClassesOf(workflow, [agentOf("a", NotAReranker)])).toThrow(
      new ComponentError({
        message: `@Workflow "w": NotAReranker in an agent's rag is not a @Rag`,
      }),
    );
    expect(() =>
      ragClassesOf(workflow, [
        agentOf(
          "a",
          class Unknown {
            readonly unknown = true;
          },
        ),
      ]),
    ).toThrow(ComponentError);
  });

  it("[agent.duplicate-rag]: one @Rag listed twice in one agent is refused, naming the agent", () => {
    const failed = (): unknown => ragClassesOf(workflow, [agentOf("a", JobsRag, JobsRag)]);

    expect(failed).toThrow(GraphRuleError);
    expect(failed).toThrow(/agent\.duplicate-rag|listed twice/u);
    // two agents may list the same one
    expect(ragClassesOf(workflow, [agentOf("a", JobsRag), agentOf("b", JobsRag)])).toEqual([
      JobsRag,
    ]);
  });

  it("are checked for scope and reranking only when there are some", async () => {
    await checkedRagClassesOf(workflow, [agentOf("a")]);
    expect(checkRags).not.toHaveBeenCalled();

    const rags = await checkedRagClassesOf(workflow, [agentOf("a", JobsRag)]);

    expect(rags).toEqual([JobsRag]);
    expect(checkRags).toHaveBeenCalledExactlyOnceWith([JobsRag]);
  });
});

describe("#1366: the meta of a knowledge base", () => {
  it("is asked of the container's components as a @Rag, named for the workflow's assembly", () => {
    expect(ragMeta(JobsRag)).toBe(ragMetas[JobsRag.name]);
    expect(requireComponent).toHaveBeenCalledWith(JobsRag, "rag", "workflowOf");
  });
});

describe("#1366: a knowledge base as a config entry", () => {
  it("has its name, top-k and scope, and no reranking when it has none", () => {
    const [entry] = ragSettings(agentOf("a", JobsRag));

    expect(entry).toStrictEqual({ name: "jobs-rag", topK: 5, scope: "tenant" });
    expect(ragSettings({ name: "bare" } as never)).toEqual([]);
  });

  it("names its reranker, its candidates and, by default, that a failure fails the step", () => {
    const [entry] = ragSettings(agentOf("a", DocsRag));

    expect(entry).toMatchObject({
      rerank: {
        reranker: "model-reranker",
        candidates: 20,
        onFailure: RerankFailurePolicy.FailStep,
      },
    });
  });

  it("keeps the failure policy it was given, and names no reranking whose `reranker` is no reranker", () => {
    rerankerMeta[ModelReranker.name] = {
      name: "model-reranker",
      candidates: 20,
      onFailure: RerankFailurePolicy.Fallback,
    };
    ragMetas[JobsRag.name] = {
      name: "jobs-rag",
      topK: 5,
      scope: "tenant",
      reranker: NotAReranker,
    };

    const [docs, jobs] = ragSettings(agentOf("a", DocsRag, JobsRag));

    expect(docs).toMatchObject({ rerank: { onFailure: RerankFailurePolicy.Fallback } });
    expect(Object.keys(jobs ?? {})).not.toContain("rerank");

    class Unregistered {
      readonly unregistered = true;
    }
    ragMetas[JobsRag.name] = { name: "jobs-rag", topK: 5, scope: "tenant", reranker: Unregistered };
    const [, unknown] = ragSettings(agentOf("a", DocsRag, JobsRag));
    expect(Object.keys(unknown ?? {})).not.toContain("rerank");
    expect(rerankerClassesOf([JobsRag])).toEqual([Unregistered]);
    expect(rerankerModelsOf([JobsRag])).toEqual([]);
  });
});

describe("#1366: the rerankers of knowledge bases", () => {
  it("are the classes the knowledge bases rerank by, none for one with no reranking", () => {
    expect(rerankerClassesOf([JobsRag, DocsRag])).toEqual([ModelReranker]);
    expect(rerankerClassesOf([JobsRag])).toEqual([]);
  });

  it("a model reranker's own model is the one it is given; a code reranker and a `reranker` that is none get none, and one is named once", () => {
    ragMetas[JobsRag.name] = { name: "jobs-rag", topK: 5, scope: "tenant", reranker: CodeReranker };

    expect(rerankerModelsOf([JobsRag, DocsRag, DocsRag])).toEqual([
      { name: "model-reranker", model: "cheap" },
    ]);
  });

  it("with no model of its own and no provider anywhere it is [model.missing-provider] — the core has no default", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20 };

    expect(() => rerankerModelsOf([DocsRag])).toThrow(GraphRuleError);
    expect(() => rerankerModelsOf([DocsRag])).toThrow(/names no model/u);
  });
});

/** A provider with a default model and a role of its own, and one with neither. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://fast.test/v1" }),
  model: "fast/default",
  models: { cheap: "fast/cheap" },
  timeout: seconds(5),
})
class Fast {}

@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bare.test/v1" }),
  timeout: seconds(5),
})
class Bare {}

describe("#1366: a model reranker's model through the cascade", () => {
  it("none of its own: the default of its provider — its own, else its workflow's, else its application's", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20 };
    // a provider with no cost: its calls are unpriced, the mark travels with the model (bughunt 2026-11-25 #2)
    const expected = [
      { name: "model-reranker", model: "fast/default", modelProvider: "fast", unpriced: true },
    ];

    expect(rerankerModelsOf([DocsRag], { workflow: Fast })).toEqual(expected);
    expect(rerankerModelsOf([DocsRag], { application: Fast })).toEqual(expected);
    rerankerMeta[ModelReranker.name] = {
      name: "model-reranker",
      candidates: 20,
      modelProvider: Fast,
    };
    expect(rerankerModelsOf([DocsRag], { workflow: Bare })).toEqual(expected);
  });

  it("a role is the provider's mapping; a name no mapping knows is the vendor's own", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20, model: "cheap" };
    expect(rerankerModelsOf([DocsRag], { workflow: Fast })).toEqual([
      { name: "model-reranker", model: "fast/cheap", modelProvider: "fast", unpriced: true },
    ]);
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20, model: "x/y" };
    expect(rerankerModelsOf([DocsRag], { workflow: Fast })).toEqual([
      { name: "model-reranker", model: "x/y", modelProvider: "fast", unpriced: true },
    ]);
  });

  it("[model.missing]: a provider with no model or models.default serves no reranker that names none", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20 };

    expect(() => rerankerModelsOf([DocsRag], { workflow: Bare })).toThrow(
      /has no model or models\.default/u,
    );
  });
});

describe("#1366: the scope of a retrieval", () => {
  const services = {} as never;
  const metaOf = (scope: unknown) => ({ name: "jobs-rag", scope }) as never;
  const frameOf = (options: { tenantId?: string; ownerId?: string; isClosed?: boolean } = {}) => ({
    isClosed: () => options.isClosed ?? false,
    step: { nodeId: "n", visitNumber: 1, component: { name: "a" } },
    execution: {
      executionId: "e1",
      ownerId: options.ownerId,
      tenant: { tenantId: options.tenantId ?? "tenant-1" },
    },
  });
  const inFrame = (frame: unknown) => vi.mocked(currentFrame).mockReturnValue(frame as never);

  it("Shared: none; Tenant: the execution's tenant; Owner: the execution's owner", () => {
    inFrame(frameOf({ ownerId: "alice" }));

    expect(scopeKeyOfRetrieval(metaOf(RagScope.Shared), {}, services)).toEqual({});
    expect(scopeKeyOfRetrieval(metaOf(RagScope.Tenant), {}, services)).toEqual({
      tenantId: "tenant-1",
      scopeId: "tenant-1",
      scope: RagScope.Tenant,
    });
    expect(scopeKeyOfRetrieval(metaOf(RagScope.Owner), {}, services)).toEqual({
      tenantId: "tenant-1",
      scopeId: "alice",
      scope: RagScope.Owner,
    });
  });

  it("is never the default one: outside an execution it is refused, naming the knowledge base", () => {
    vi.mocked(currentFrame).mockReturnValue(undefined);

    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Tenant), {}, services)).toThrow(
      ExecutionContextUnavailableError.outside({
        consumer: "@Rag jobs-rag",
        field: "executionContext",
      }),
    );
  });

  it("through the frame of a step that ended it is refused, and a tenant id that is no key is refused", () => {
    inFrame(frameOf({ isClosed: true }));
    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Tenant), {}, services)).toThrow(
      /after its step ended/,
    );

    inFrame(frameOf({ tenantId: "" }));
    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Tenant), {}, services)).toThrow(
      ValidationError.DtoInvalid,
    );
  });

  it("Owner with no owner, a scope that is none of the four, a Custom with no resolver: fail closed", () => {
    inFrame(frameOf());

    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Owner), {}, services)).toThrow(RagScopeError);
    expect(() => scopeKeyOfRetrieval(metaOf("everyone"), {}, services)).toThrow(RagScopeError);
    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Custom), {}, services)).toThrow(RagScopeError);
  });
});

describe("#1366: the reranker bound to a knowledge base", () => {
  const instance = vi.fn((cls: unknown) => ({ instanceOf: cls }));
  const bound = (use: object, services: object = {}) =>
    boundRerankerOf(
      (ragMetas[(use as { name: string }).name] ?? {}) as never,
      instance,
      services as never,
    );

  it("is none for a knowledge base that does not rerank, or whose reranker is none", () => {
    expect(bound(JobsRag)).toBeUndefined();

    ragMetas[JobsRag.name] = { name: "jobs-rag", reranker: NotAReranker };
    expect(bound(JobsRag)).toBeUndefined();
  });

  it("is a model reranker: its candidates, a failed step by default, and its model from the gateway of the services", () => {
    const rerankModel = vi.fn((use: { name: string; model: string }) => use);
    const out = bound(DocsRag, { rerankModel });

    expect(out).toMatchObject({
      rag: "docs-rag",
      reranker: "model-reranker",
      candidates: 20,
      onFailure: RerankFailurePolicy.FailStep,
      source: { kind: "model" },
    });
    const source = out?.source as { binding: () => unknown };
    expect(source.binding()).toEqual({ name: "model-reranker", model: "cheap" });
  });

  it("a model reranker with no gateway here refuses", () => {
    const without = bound(DocsRag)?.source as { binding: () => unknown };

    expect(() => without.binding()).toThrow(
      new ComponentError({
        message: "[reranker.no-model-gateway] model-reranker: no model gateway here",
      }),
    );
  });

  it("is a code reranker when its class has rerank(): its instance is the container's, the failure policy the one it was given", () => {
    ragMetas[JobsRag.name] = { name: "jobs-rag", reranker: CodeReranker };
    rerankerMeta[CodeReranker.name] = {
      name: "code-reranker",
      candidates: 7,
      onFailure: RerankFailurePolicy.Fallback,
      maxCandidateLength: 90,
    };

    const out = bound(JobsRag);

    expect(out).toMatchObject({
      reranker: "code-reranker",
      candidates: 7,
      maxCandidateLength: 90,
      onFailure: RerankFailurePolicy.Fallback,
      source: { kind: "code" },
    });
    expect((out?.source as { instance: () => unknown }).instance()).toEqual({
      instanceOf: CodeReranker,
    });
  });
});

describe("#1366: the retrieval of a knowledge base", () => {
  const source = {};
  const services = {} as never;
  const meta = { name: "docs-rag", topK: 3, scope: RagScope.Tenant } as never;

  beforeEach(() => {
    vi.mocked(currentFrame).mockReturnValue({
      isClosed: () => false,
      execution: { tenant: { tenantId: "tenant-1" } },
    } as never);
  });

  it("without a reranker asks the source for the scope's results, as many as asked, with the filter it was given", async () => {
    const signal = new AbortController().signal;

    await knowledgeRetrieveOf(
      meta,
      source,
      undefined,
      services,
    )("query", {
      topK: 4,
      signal,
      filter: { lang: "en" },
    });

    expect(retrieveOf).toHaveBeenCalledWith(source, "query", {
      topK: 4,
      signal,
      tenantId: "tenant-1",
      scopeId: "tenant-1",
      scope: RagScope.Tenant,
      filter: { lang: "en" },
    });
  });

  it("with a reranker hands it a fetch of the scope's candidates, and the query, the top-k and the scope", async () => {
    const signal = new AbortController().signal;
    const reranker = { reranker: "model-reranker" } as never;
    vi.mocked(rerankedRetrieval).mockImplementation(async (fetch) => {
      await fetch(20);
      return { results: [{ source: "s", text: "t" }] };
    });

    const out = await knowledgeRetrieveOf(
      meta,
      source,
      reranker,
      services,
    )("query", { topK: 4, signal });

    expect(out).toEqual({ results: [{ source: "s", text: "t" }] });
    expect(retrieveOf).toHaveBeenCalledWith(source, "query", {
      topK: 20,
      signal,
      tenantId: "tenant-1",
      scopeId: "tenant-1",
      scope: RagScope.Tenant,
    });
    expect(rerankedRetrieval).toHaveBeenCalledWith(expect.any(Function), reranker, {
      query: "query",
      topK: 4,
      tenantId: "tenant-1",
      scopeId: "tenant-1",
      scope: RagScope.Tenant,
      signal,
    });
  });

  it("a call that cannot name its scope reads nothing: the source and the reranker are never reached", async () => {
    vi.mocked(currentFrame).mockReturnValue(undefined);
    const signal = new AbortController().signal;

    await expect(
      knowledgeRetrieveOf(
        meta,
        source,
        { reranker: "r" } as never,
        services,
      )("query", {
        topK: 4,
        signal,
      }),
    ).rejects.toThrow(/outside an execution/u);

    expect(retrieveOf).not.toHaveBeenCalled();
    expect(rerankedRetrieval).not.toHaveBeenCalled();
  });
});

describe("#1366: the knowledge bases retrieved before an agent runs", () => {
  it("are the ones its rag list names, by agent, with their top-k and a retrieval", () => {
    const runtimeOf = vi.fn((cls: unknown) => ({
      name: cls === JobsRag ? "jobs-rag" : "docs-rag",
      topK: cls === JobsRag ? 5 : 3,
      retrieve: vi.fn(),
    }));
    const agents = [agentOf("a", JobsRag), { name: "bare" } as never];

    const sources = contextSources(agents, runtimeOf);

    const [first] = sources.get("a") ?? [];
    expect(sources.get("a")).toHaveLength(1);
    expect(first).toMatchObject({ name: "jobs-rag", topK: 5 });
    expect(first?.retrieve).toBeTypeOf("function");
    expect(sources.get("bare")).toEqual([]);
    expect([...sources.keys()]).toEqual(["a", "bare"]);
  });
});
