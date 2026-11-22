/**
 * #1366 (ledger-retention shard) — what a knowledge base's file settles besides its search tool's cost, each rule on its
 * own over fakes: the classes an agent binds are @Rag classes (named when not), the config entries describe and
 * `configHash` read (the top-k, the reranking's candidates and failure policy), the models a reranker is given, the
 * tenant every retrieval is made for (never the default one), and the reranker bound to a knowledge base — a model one
 * refused without a gateway — with the retrieval that runs through it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundRerankerOf,
  checkedRagClassesOf,
  contextSources,
  knowledgeRetrieveOf,
  ragClassesOf,
  ragMeta,
  ragSettings,
  rerankerClassesOf,
  rerankerModelsOf,
  tenantOfRetrieval,
} from "../../src/components/rag.js";
import { ComponentError, componentOf, requireComponent } from "../../src/components/metadata.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { checkRags } from "../../src/rag/rag-checks.js";
import { rerankedRetrieval } from "../../src/rag/rerank.js";
import { DEFAULT_RERANKER_MODEL, RagMode, RerankFailurePolicy } from "../../src/rag/types.js";

vi.mock("../../src/components/metadata.js", async (original) => ({
  ...(await original<typeof import("../../src/components/metadata.js")>()),
  componentOf: vi.fn(),
  requireComponent: vi.fn(),
}));
vi.mock("../../src/flow/context/frame.js", () => ({ currentFrame: vi.fn() }));
vi.mock("../../src/rag/rag-checks.js", () => ({ checkRags: vi.fn() }));
vi.mock("../../src/rag/rerank.js", () => ({ rerankedRetrieval: vi.fn() }));

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
}
class NotAReranker {
  readonly kind = "none";
}

/** The metas of each test, made afresh: a test changes the ones it needs. */
let rerankerMeta: Record<string, object> = {};
let ragMetas: Record<string, object> = {};
const freshMetas = (): void => {
  rerankerMeta = {
    [ModelReranker.name]: { name: "model-reranker", decidedBy: DecidedBy.Model, model: "cheap" },
    [CodeReranker.name]: { name: "code-reranker", decidedBy: DecidedBy.Code },
  };
  ragMetas = {
    [JobsRag.name]: { name: "jobs-rag", topK: 5, tenancy: "tenant" },
    [DocsRag.name]: {
      name: "docs-rag",
      topK: 3,
      tenancy: "shared",
      rerank: { by: ModelReranker, candidates: 20 },
    },
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  freshMetas();
  vi.mocked(componentOf).mockImplementation(((cls: { name: string }) => {
    if (cls.name in ragMetas) return { kind: "rag", meta: ragMetas[cls.name] };
    if (cls.name in rerankerMeta) return { kind: "reranker", meta: rerankerMeta[cls.name] };
    return cls.name === NotAReranker.name ? { kind: "agent", meta: {} } : undefined;
  }) as never);
  vi.mocked(requireComponent).mockImplementation(((cls: { name: string }) => ({
    kind: "rag",
    meta: ragMetas[cls.name],
  })) as never);
});

const bind = (use: unknown, mode: RagMode = RagMode.Tool) => ({ use, mode });
const agentOf = (name: string, ...rag: object[]) => ({ name, rag }) as never;

describe("#1366: the knowledge bases an agent binds", () => {
  it("are the @Rag classes of the workflow's agents, each once", () => {
    const agents = [agentOf("a", bind(JobsRag), bind(DocsRag)), agentOf("b", bind(JobsRag))];

    expect(ragClassesOf({ name: "w" } as never, agents)).toEqual([JobsRag, DocsRag]);
    expect(ragClassesOf({ name: "w" } as never, [{ name: "bare" } as never])).toEqual([]);
  });

  it("a class that is no @Rag is refused by name, naming the workflow", () => {
    expect(() => ragClassesOf({ name: "w" } as never, [agentOf("a", bind(NotAReranker))])).toThrow(
      new ComponentError({
        message: `@Workflow "w": NotAReranker in an agent's rag is not a @Rag`,
      }),
    );
    expect(() =>
      ragClassesOf({ name: "w" } as never, [
        agentOf(
          "a",
          bind(
            class Unknown {
              readonly unknown = true;
            },
          ),
        ),
      ]),
    ).toThrow(ComponentError);
  });

  it("are checked for tenancy and reranking only when there are some", async () => {
    await checkedRagClassesOf({ name: "w" } as never, [agentOf("a")]);
    expect(checkRags).not.toHaveBeenCalled();

    const rags = await checkedRagClassesOf({ name: "w" } as never, [agentOf("a", bind(JobsRag))]);

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
  it("has its name, mode, top-k and tenancy, and no reranking when it has none", () => {
    const [entry] = ragSettings(agentOf("a", bind(JobsRag, RagMode.Context)));

    expect(entry).toStrictEqual({ name: "jobs-rag", mode: "context", topK: 5, tenancy: "tenant" });
    expect(ragSettings({ name: "bare" } as never)).toEqual([]);
  });

  it("names its reranker, its candidates and, by default, a fallback when the reranker fails", () => {
    const [entry] = ragSettings(agentOf("a", bind(DocsRag)));

    expect(entry).toMatchObject({
      rerank: {
        reranker: "model-reranker",
        candidates: 20,
        onFailure: RerankFailurePolicy.Fallback,
      },
    });
  });

  it("keeps the failure policy it was given, and names no reranking whose `by` is no reranker", () => {
    ragMetas[DocsRag.name] = {
      name: "docs-rag",
      topK: 3,
      tenancy: "shared",
      rerank: { by: ModelReranker, candidates: 20, onFailure: RerankFailurePolicy.FailStep },
    };
    ragMetas[JobsRag.name] = {
      name: "jobs-rag",
      topK: 5,
      tenancy: "tenant",
      rerank: { by: NotAReranker, candidates: 9 },
    };

    const [docs, jobs] = ragSettings(agentOf("a", bind(DocsRag), bind(JobsRag)));

    expect(docs).toMatchObject({ rerank: { onFailure: RerankFailurePolicy.FailStep } });
    expect(Object.keys(jobs ?? {})).not.toContain("rerank");

    class Unregistered {
      readonly unregistered = true;
    }
    ragMetas[JobsRag.name] = {
      name: "jobs-rag",
      topK: 5,
      tenancy: "tenant",
      rerank: { by: Unregistered, candidates: 9 },
    };
    const [, unknown] = ragSettings(agentOf("a", bind(DocsRag), bind(JobsRag)));
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

  it("get the model of their own, else the default one; a code reranker and a `by` that is none get none, and one is named once", () => {
    ragMetas[JobsRag.name] = {
      name: "jobs-rag",
      topK: 5,
      tenancy: "tenant",
      rerank: { by: CodeReranker, candidates: 9 },
    };
    rerankerMeta[ModelReranker.name] = {
      name: "model-reranker",
      decidedBy: DecidedBy.Model,
    };

    const models = rerankerModelsOf([JobsRag, DocsRag, DocsRag]);

    expect(models).toEqual([{ name: "model-reranker", model: DEFAULT_RERANKER_MODEL }]);
  });

  it("a model reranker's own model is the one it is given", () => {
    expect(rerankerModelsOf([DocsRag])).toEqual([{ name: "model-reranker", model: "cheap" }]);
  });
});

describe("#1366: the tenant of a retrieval", () => {
  const meta = { name: "jobs-rag" } as never;
  const frameOf = (tenantId: string, isClosed = false) => ({
    isClosed: () => isClosed,
    step: { nodeId: "n", visitNumber: 1, component: { name: "a" } },
    execution: { executionId: "e1", tenant: { tenantId } },
  });

  it("is the execution's, read from the frame of the step that runs it", () => {
    vi.mocked(currentFrame).mockReturnValue(frameOf("tenant-1") as never);

    expect(tenantOfRetrieval(meta)).toBe("tenant-1");
  });

  it("is never the default tenant: outside an execution it is refused, naming the knowledge base", () => {
    vi.mocked(currentFrame).mockReturnValue(undefined);

    expect(() => tenantOfRetrieval(meta)).toThrow(
      ExecutionContextUnavailableError.outside({
        consumer: "@Rag jobs-rag",
        field: "tenantContext.tenantId",
      }),
    );
  });

  it("through the frame of a step that ended it is refused, and a tenant id that is no key is refused", () => {
    vi.mocked(currentFrame).mockReturnValue(frameOf("tenant-1", true) as never);
    expect(() => tenantOfRetrieval(meta)).toThrow(/after its step ended/);

    vi.mocked(currentFrame).mockReturnValue(frameOf("") as never);
    expect(() => tenantOfRetrieval(meta)).toThrow(DtoValidationError);
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
    ragMetas[JobsRag.name] = { name: "jobs-rag", topK: 5, tenancy: "tenant" };
    expect(bound(JobsRag)).toBeUndefined();

    ragMetas[JobsRag.name] = { name: "jobs-rag", rerank: { by: NotAReranker, candidates: 9 } };
    expect(bound(JobsRag)).toBeUndefined();
  });

  it("is a model reranker: its candidates, a fallback by default, and its model from the gateway of the services", () => {
    const rerankModel = vi.fn((name: string, model: string) => ({ name, model }));
    const out = bound(DocsRag, { rerankModel });

    expect(out).toMatchObject({
      rag: "docs-rag",
      reranker: "model-reranker",
      candidates: 20,
      onFailure: RerankFailurePolicy.Fallback,
      source: { kind: "model" },
    });
    const source = out?.source as { binding: () => unknown };
    expect(source.binding()).toEqual({ name: "model-reranker", model: "cheap" });
  });

  it("a model reranker with no model of its own is given the default one, and one with no gateway here refuses", () => {
    rerankerMeta[ModelReranker.name] = {
      name: "model-reranker",
      decidedBy: DecidedBy.Model,
    };
    const rerankModel = vi.fn(() => "bound");

    const withGateway = bound(DocsRag, { rerankModel })?.source as {
      binding: () => unknown;
    };
    const without = bound(DocsRag)?.source as { binding: () => unknown };
    withGateway.binding();

    expect(rerankModel).toHaveBeenCalledWith("model-reranker", DEFAULT_RERANKER_MODEL);
    expect(() => without.binding()).toThrow(
      new ComponentError({
        message: "[reranker.no-model-gateway] model-reranker: no model gateway here",
      }),
    );
  });

  it("is a code reranker when it is decided by code: its instance is the container's, the failure policy the one it was given", () => {
    ragMetas[JobsRag.name] = {
      name: "jobs-rag",
      rerank: { by: CodeReranker, candidates: 7, onFailure: RerankFailurePolicy.FailStep },
    };

    const out = bound(JobsRag);

    expect(out).toMatchObject({
      reranker: "code-reranker",
      candidates: 7,
      onFailure: RerankFailurePolicy.FailStep,
      source: { kind: "code" },
    });
    expect((out?.source as { instance: () => unknown }).instance()).toEqual({
      instanceOf: CodeReranker,
    });
  });
});

describe("#1366: the retrieval of a knowledge base", () => {
  const connector = { retrieve: vi.fn(() => Promise.resolve({ results: [] })) };
  const meta = { name: "docs-rag", topK: 3 } as never;

  beforeEach(() => {
    vi.mocked(currentFrame).mockReturnValue({
      isClosed: () => false,
      execution: { tenant: { tenantId: "tenant-1" } },
    } as never);
  });

  it("without a reranker asks the connector for the tenant's results, as many as asked", async () => {
    const signal = new AbortController().signal;

    await knowledgeRetrieveOf(meta, connector, undefined)("query", { topK: 4, signal });

    expect(connector.retrieve).toHaveBeenCalledWith("query", {
      topK: 4,
      signal,
      tenantId: "tenant-1",
    });
  });

  it("with a reranker hands it a fetch of the tenant's candidates, and the query, the top-k and the tenant", async () => {
    const signal = new AbortController().signal;
    const reranker = { reranker: "model-reranker" } as never;
    vi.mocked(rerankedRetrieval).mockImplementation(async (fetch) => {
      await fetch(20);
      return { results: [{ source: "s", text: "t" }] };
    });

    const out = await knowledgeRetrieveOf(
      meta,
      connector,
      reranker,
    )("query", {
      topK: 4,
      signal,
    });

    expect(out).toEqual({ results: [{ source: "s", text: "t" }] });
    expect(connector.retrieve).toHaveBeenCalledWith("query", {
      topK: 20,
      signal,
      tenantId: "tenant-1",
    });
    expect(rerankedRetrieval).toHaveBeenCalledWith(expect.any(Function), reranker, {
      query: "query",
      topK: 4,
      tenantId: "tenant-1",
      signal,
    });
  });
});

describe("#1366: the knowledge bases retrieved before an agent runs", () => {
  it("are the ones its tool-less context mode names, by agent, with their top-k and a retrieval", () => {
    const connectorOf = vi.fn(() => ({ retrieve: vi.fn() }));
    const agents = [
      agentOf("a", bind(JobsRag, RagMode.Context), bind(DocsRag, RagMode.Tool)),
      { name: "bare" } as never,
    ];

    const sources = contextSources(agents, connectorOf, {} as never);

    const [first] = sources.get("a") ?? [];
    expect(sources.get("a")).toHaveLength(1);
    expect(first).toMatchObject({ name: "jobs-rag", topK: 5 });
    expect(first?.retrieve).toBeTypeOf("function");
    expect(sources.get("bare")).toEqual([]);
    expect([...sources.keys()]).toEqual(["a", "bare"]);
  });
});
