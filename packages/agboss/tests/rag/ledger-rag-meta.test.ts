import { ConfigError } from "../../src/core/error-families/config-errors.js";
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
import {
  boundRerankerOf,
  rerankerModelsOf,
  rerankerPromptsOf,
} from "../../src/components/rag-reranker.js";
import { knowledgeRetrieveOf } from "../../src/components/rag-retrieval.js";
import { scopeKeyOfRetrieval } from "../../src/components/rag-scope.js";
import { componentOf, requireComponent } from "../../src/components/metadata.js";
import { modelResolverOf } from "../../src/models/model-resolver.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { checkRags } from "../../src/rag/rag-checks.js";
import { retrieveOf } from "../../src/rag/rag-source.js";
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
      new ConfigError.Component({
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
    ).toThrow(ConfigError.Component);
  });

  it("[agent.duplicate-rag]: one @Rag listed twice in one agent is refused, naming the agent", () => {
    const failed = (): unknown => ragClassesOf(workflow, [agentOf("a", JobsRag, JobsRag)]);

    expect(failed).toThrow(ConfigError.GraphRules);
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

    expect(() => rerankerModelsOf([DocsRag])).toThrow(ConfigError.GraphRules);
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

    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Owner), {}, services)).toThrow(
      ConfigError.Component,
    );
    expect(() => scopeKeyOfRetrieval(metaOf("everyone"), {}, services)).toThrow(
      ConfigError.Component,
    );
    expect(() => scopeKeyOfRetrieval(metaOf(RagScope.Custom), {}, services)).toThrow(
      ConfigError.Component,
    );
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
      new ConfigError.Component({
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

describe("#1356: the knowledge bases of a workflow, rule by rule", () => {
  class PlainTool {
    readonly kind = "plain";
  }
  class OtherClass {
    readonly kind = "other";
  }
  class NoComponent {
    readonly kind = "none";
  }

  it("a @Rag listed twice is refused with the rule's code, its text and the agent it points at", () => {
    const failure = (() => {
      try {
        ragClassesOf(workflow, [agentOf("a", JobsRag, JobsRag, DocsRag)]);
      } catch (error) {
        return error as ConfigError.GraphRules;
      }
      throw new Error("not refused");
    })();

    expect(
      failure.violations.map(({ code, message, nodes }) => ({ code, message, nodes })),
    ).toEqual([
      {
        code: "agent.duplicate-rag",
        message: '@Agent "a": JobsRag is listed twice in rag — list it once',
        nodes: ["a"],
      },
    ]);
  });

  it("an agent with no rag lists none and breaks no rule", () => {
    expect(ragClassesOf(workflow, [{ name: "bare" } as never])).toEqual([]);
    expect(ragClassesOf(workflow, [{ name: "bare" } as never, agentOf("b", DocsRag)])).toEqual([
      DocsRag,
    ]);
  });

  it("the @Rag classes a tool injects: only its deps that are @Rag classes, none for a class that is no tool or a tool with none", () => {
    toolMetas[PlainTool.name] = {
      name: "plain",
      deps: [OtherClass, "a-token", NoComponent, DocsRag, JobsRag],
    };
    toolMetas[OtherClass.name] = { name: "other", deps: [] };

    expect(ragClassesOf(workflow, [], [PlainTool as never])).toEqual([DocsRag, JobsRag]);
    expect(
      ragClassesOf(
        workflow,
        [],
        [
          DocsRag as never,
          OtherClass as never,
          class Unknown {
            readonly unknown = true;
          },
        ],
      ),
    ).toEqual([]);
    expect(ragClassesOf(workflow, [], [])).toEqual([]);
    expect(ragClassesOf(workflow, [])).toEqual([]);
  });

  it("without tools to look at, the knowledge bases to check are the agents' alone", async () => {
    const rags = await checkedRagClassesOf(workflow, [agentOf("a", JobsRag)]);
    const withTools = await checkedRagClassesOf(workflow, [agentOf("a", JobsRag)], [SearchTool]);

    expect(rags).toEqual([JobsRag]);
    expect(withTools).toEqual([JobsRag]);
  });
});

describe("#1356: the rerankers of knowledge bases, rule by rule", () => {
  it("a model reranker with no model anywhere names the use it is of in the violation", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20 };

    expect(() => rerankerModelsOf([DocsRag])).toThrow(
      /\[model\.missing-provider\] rerankers ragRerankers\.model-reranker: names no model/u,
    );
    expect(() => rerankerModelsOf([DocsRag], { workflow: Bare })).toThrow(
      /\[model\.missing\] rerankers ragRerankers\.model-reranker: names no model/u,
    );
  });

  it("a prompt read for a reranker is on its model, none when it has none, never an empty one", () => {
    const prompts = new Map([["model-reranker", "Rank by recency."]]);

    expect(rerankerModelsOf([DocsRag], {}, prompts)).toStrictEqual([
      { name: "model-reranker", model: "cheap", prompt: "Rank by recency." },
    ]);
    expect(rerankerModelsOf([DocsRag], {}, new Map())).toStrictEqual([
      { name: "model-reranker", model: "cheap" },
    ]);
    expect(rerankerModelsOf([DocsRag], {}, new Map([["model-reranker", ""]]))).toStrictEqual([
      { name: "model-reranker", model: "cheap" },
    ]);
  });

  it("on the workflow's own resolver the violations are the workflow's to throw: it is not checked here", () => {
    const shared = modelResolverOf("workflow", {});
    const sharedCheck = vi.spyOn(shared, "check");

    expect(rerankerModelsOf([DocsRag], {}, new Map(), shared)).toEqual([
      { name: "model-reranker", model: "cheap" },
    ]);
    expect(sharedCheck).not.toHaveBeenCalled();
  });

  it("their prompts are read once for each model reranker, under its name, with its own source and the label that names it", async () => {
    rerankerMeta[ModelReranker.name] = {
      name: "model-reranker",
      candidates: 20,
      prompt: "Rank it.",
      source: "/repo/rerank.ts",
    };
    const load = vi.fn(({ label }: { label: string }) => Promise.resolve(`loaded ${label}`));

    const prompts = await rerankerPromptsOf([JobsRag, DocsRag, DocsRag], { load } as never);

    expect([...prompts]).toEqual([["model-reranker", 'loaded @RagReranker "model-reranker"']]);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith({
      label: '@RagReranker "model-reranker"',
      options: { prompt: "Rank it." },
      source: "/repo/rerank.ts",
    });
  });

  it("a code reranker has no prompt to read, and no knowledge base has none to read at all", async () => {
    ragMetas[JobsRag.name] = { name: "jobs-rag", reranker: CodeReranker };
    const load = vi.fn();

    expect([...(await rerankerPromptsOf([JobsRag], { load } as never))]).toEqual([]);
    expect([...(await rerankerPromptsOf([], { load } as never))]).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("#1356: the reranker bound to a knowledge base, rule by rule", () => {
  const instance = vi.fn((cls: unknown) => ({ instanceOf: cls }));
  const boundOf = (services: object, cascade?: object) =>
    boundRerankerOf(ragMetas[DocsRag.name] as never, instance, services as never, cascade);

  it("its instructions are the services', else none", () => {
    const rerankInstructions = vi.fn((name: string) => `rank as ${name} says`);

    expect(boundOf({ rerankInstructions })?.instructions).toBe("rank as model-reranker says");
    expect(boundOf({})?.instructions).toBe("");
    expect(rerankInstructions).toHaveBeenCalledWith("model-reranker");
  });

  it("the model is resolved through the cascade at the call: a cascade that gives no model fails the call, not the gateway", () => {
    rerankerMeta[ModelReranker.name] = { name: "model-reranker", candidates: 20 };
    const rerankModel = vi.fn();

    const binding = (boundOf({ rerankModel })?.source as { binding: () => unknown }).binding;

    expect(binding).toThrow(/rerankers|jobs|docs-rag/u);
    expect(binding).toThrow(/names no model/u);
    expect(rerankModel).not.toHaveBeenCalled();
  });
});

class ExecutionContextOfProject {
  readonly kind = "context";
}

describe("#1356: the scope of a retrieval, rule by rule", () => {
  const services = {} as never;
  const metaOf = (scope: unknown) => ({ name: "jobs-rag", scope }) as never;
  const frameOf = (execution: object = {}) => ({
    isClosed: () => false,
    step: { nodeId: "n", visitNumber: 1, component: { name: "a" } },
    execution: { executionId: "e1", tenant: { tenantId: "tenant-1" }, ...execution },
  });
  const inFrame = (frame: unknown) => vi.mocked(currentFrame).mockReturnValue(frame as never);
  const messageOf = (make: () => unknown): string => {
    try {
      make();
    } catch (error) {
      return (error as Error).message;
    }
    return "not refused";
  };

  it("an owner scope with no owner says so, naming the knowledge base", () => {
    inFrame(frameOf());

    expect(messageOf(() => scopeKeyOfRetrieval(metaOf(RagScope.Owner), {}, services))).toBe(
      "[config.component] @Rag jobs-rag has scope RagScope.Owner and this execution has no owner — pass owner in the call's options",
    );
  });

  it("an owner id that is no key is refused naming the field and the knowledge base, never the id", () => {
    inFrame(frameOf({ ownerId: "bob\u0007" }));

    const message = messageOf(() => scopeKeyOfRetrieval(metaOf(RagScope.Owner), {}, services));

    expect(message).toContain("@Rag jobs-rag");
    expect(message).toContain("owner");
    expect(message).not.toContain("bob");
  });

  it("a scope that is none of the four says what it may be", () => {
    inFrame(frameOf());

    expect(messageOf(() => scopeKeyOfRetrieval(metaOf("everyone"), {}, services))).toBe(
      "[rag.scope-required] @Rag jobs-rag declares no known scope — scope: RagScope.Shared, Tenant, Owner or Custom",
    );
  });

  it("a tenant id that is no key is refused before any scope resolves", () => {
    inFrame(frameOf({ tenant: { tenantId: "" } }));

    for (const scope of [RagScope.Tenant, RagScope.Owner, RagScope.Custom])
      expect(() => scopeKeyOfRetrieval(metaOf(scope), {}, services)).toThrow(
        ValidationError.DtoInvalid,
      );
  });

  it("a custom scope with no resolver says so", () => {
    inFrame(frameOf());

    expect(messageOf(() => scopeKeyOfRetrieval(metaOf(RagScope.Custom), {}, services))).toBe(
      "[rag.custom-scope-missing-resolver] @Rag jobs-rag has scope RagScope.Custom and no resolveScope(context)",
    );
  });

  it("a custom scope is the id its source resolves from the live context, as the scope of the tenant", () => {
    inFrame(frameOf());
    const resolveScope = vi.fn((_context: unknown) => "project-9");
    const source = { resolveScope };
    const withContext = { contexts: { executionContext: ExecutionContextOfProject } } as never;

    const key = (() => {
      try {
        return scopeKeyOfRetrieval(metaOf(RagScope.Custom), source, withContext);
      } catch (error) {
        return error;
      }
    })();

    expect(key).toEqual({ tenantId: "tenant-1", scopeId: "project-9", scope: RagScope.Custom });
    expect(resolveScope).toHaveBeenCalledOnce();
    expect(resolveScope.mock.calls[0]).toHaveLength(1);
  });

  it.each([
    ["nothing", undefined],
    ["an empty text", ""],
    ["a number", 5],
    ["null", null],
  ])("a custom scope that resolves %s fails closed, naming the knowledge base", (_why, id) => {
    inFrame(frameOf());
    const source = { resolveScope: () => id };

    expect(
      messageOf(() =>
        scopeKeyOfRetrieval(metaOf(RagScope.Custom), source, {
          contexts: { executionContext: ExecutionContextOfProject },
        } as never),
      ),
    ).toBe(
      "[config.component] @Rag jobs-rag: resolveScope returned no scope id — a custom scope names one on every call",
    );
  });

  it("a custom scope id that is no key is refused naming the field and the knowledge base", () => {
    inFrame(frameOf());
    const source = { resolveScope: () => "bad\u0007id" };

    const message = messageOf(() =>
      scopeKeyOfRetrieval(metaOf(RagScope.Custom), source, {
        contexts: { executionContext: ExecutionContextOfProject },
      } as never),
    );

    expect(message).toContain("@Rag jobs-rag");
    expect(message).toContain("scopeId");
  });

  it("the filter of a call goes to the source as it was given, and is no field when there is none", async () => {
    inFrame(frameOf());
    const signal = new AbortController().signal;
    const run = knowledgeRetrieveOf(
      { name: "docs-rag", topK: 3, scope: RagScope.Tenant } as never,
      {},
      undefined,
      services,
    );

    await run("q", { topK: 2, signal });

    expect(Object.keys(vi.mocked(retrieveOf).mock.calls[0]?.[2] ?? {})).toEqual([
      "topK",
      "signal",
      "tenantId",
      "scopeId",
      "scope",
    ]);
  });
});
