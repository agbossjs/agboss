import { z } from "zod";
import { SEARCH_TOOL_SUFFIX } from "../prompts/rag.js";
import { checkedTenantId } from "../flow/context/context-values.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { currentFrame } from "../flow/context/frame.js";
import {
  DEFAULT_RERANKER_MODEL,
  RagMode,
  RerankFailurePolicy,
  type KnowledgeRetrieval,
  type KnowledgeRetrieve,
  type KnowledgeSource,
  type RagConnector,
} from "../rag/types.js";
import type { BoundReranker } from "../rag/rerank.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { WorkflowServices } from "../workflow.js";
import { defineTool, type AnyTool } from "../tools/index.js";
import type { Class } from "./injection.js";
import { ComponentError, componentOf, requireComponent } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";

export type RagMeta = Extract<ReturnType<typeof componentOf>, { kind: "rag" }>["meta"];

/** The `@Rag` classes the workflow's agents bind, checked. */
export function ragClassesOf(bundle: WorkflowMeta, agents: readonly AgentMeta[]): Class[] {
  const classes = [
    ...new Set(agents.flatMap((agent) => (agent.rag ?? []).map((binding) => binding.use))),
  ];
  for (const cls of classes) {
    if (componentOf(cls)?.kind !== "rag") {
      throw new ComponentError(
        `@Workflow "${bundle.name}": ${cls.name} in an agent's rag is not a @Rag`,
      );
    }
  }
  return classes;
}

export const ragMeta = (cls: Class): RagMeta => requireComponent(cls, "rag", "workflowOf").meta;

/** The `@Rag` classes the workflow's agents bind, their reranking checked (#703: loaded only then). */
export async function checkedRagClassesOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
): Promise<Class[]> {
  const rags = ragClassesOf(bundle, agents);
  if (rags.every((cls) => ragMeta(cls).rerank === undefined)) return rags;
  const { checkRerankings } = await lazyLoad(import("../rag/rerank-checks.js"));
  checkRerankings(rags);
  return rags;
}

/** A knowledge base's search tool: `search-jobs-rag-tool` for `jobs-rag` (#268 AC9). */
export const searchToolName = (meta: RagMeta): string => `search-${meta.name}-tool`;

/** A knowledge base's reranking as its config entry says it (#703). */
export interface RagRerankSetting {
  readonly reranker: string;
  readonly candidates: number;
  readonly onFailure: RerankFailurePolicy;
}

/** The `@Reranker` meta of a knowledge base's `rerank.by`; none without `rerank`. */
const rerankerMetaOf = (meta: RagMeta) => {
  const found = meta.rerank === undefined ? undefined : componentOf(meta.rerank.by);
  return found?.kind === "reranker" ? found.meta : undefined;
};

/** A knowledge base's reranking for describe and `configHash` (#703). */
const rerankSettingOf = (meta: RagMeta): { readonly rerank?: RagRerankSetting } => {
  const reranker = rerankerMetaOf(meta);
  if (meta.rerank === undefined || reranker === undefined) return {};
  const { candidates, onFailure = RerankFailurePolicy.Fallback } = meta.rerank;
  return { rerank: { reranker: reranker.name, candidates, onFailure } };
};

/** An agent's knowledge bases as config entries (for describe and profiles). */
export const ragSettings = (
  agent: AgentMeta,
): { name: string; mode: RagMode; topK: number; rerank?: RagRerankSetting }[] =>
  (agent.rag ?? []).map((binding) => {
    const meta = ragMeta(binding.use);
    return { name: meta.name, mode: binding.mode, topK: meta.topK, ...rerankSettingOf(meta) };
  });

/** The `@Reranker` classes of knowledge bases, for the container (#703). */
export const rerankerClassesOf = (rags: readonly Class[]): Class[] =>
  rags.flatMap((cls) => {
    const by = ragMeta(cls).rerank?.by;
    return by === undefined ? [] : [by];
  });

/** A model reranker's model: its own, else the default (#703). */
export const rerankerModelsOf = (
  rags: readonly Class[],
): readonly { readonly name: string; readonly model: string }[] =>
  [
    ...new Map(
      rags.flatMap((cls) => {
        const reranker = rerankerMetaOf(ragMeta(cls));
        if (reranker === undefined || reranker.decidedBy === DecidedBy.Code) return [];
        return [[reranker.name, reranker.model ?? DEFAULT_RERANKER_MODEL] as const];
      }),
    ),
  ].map(([name, model]) => ({ name, model }));

/**
 * The tenant of a retrieval (#700): the execution's, read from the frame of the step or tool call
 * that runs it, checked as a key's text (#552: `dto.invalid` naming the rule, never the id). No
 * open frame → `context.unavailable` — never the default tenant.
 */
export function tenantOfRetrieval(meta: RagMeta): string {
  const frame = currentFrame();
  const consumer = `@Rag ${meta.name}`;
  if (frame === undefined)
    throw ExecutionContextUnavailableError.outside({ consumer, field: "tenantContext.tenantId" });
  if (frame.isClosed())
    throw ExecutionContextUnavailableError.ended(frame.step, frame.execution.executionId);
  const { tenantId } = frame.execution.tenant;
  checkedTenantId(tenantId);
  return tenantId;
}

/** A connector's retrieval with the execution's tenant on every call (#700). */
export const tenantRetrieve =
  (meta: RagMeta, connector: RagConnector): KnowledgeRetrieve =>
  (query, { topK, signal }) =>
    connector.retrieve(query, { topK, signal, tenantId: tenantOfRetrieval(meta) });

/** A knowledge base's reranker as the core runs it (#703); none without `rerank`. */
export function boundRerankerOf(
  meta: RagMeta,
  instance: (cls: Class) => unknown,
  services: WorkflowServices,
): BoundReranker | undefined {
  const reranker = rerankerMetaOf(meta);
  const { rerank } = meta;
  if (rerank === undefined || reranker === undefined) return undefined;
  const { name } = reranker;
  const model = reranker.model ?? DEFAULT_RERANKER_MODEL;
  const binding = () => {
    if (services.rerankModel === undefined)
      throw new ComponentError(`[reranker.no-model-gateway] ${name}: no model gateway here`);
    return services.rerankModel(name, model);
  };
  return {
    rag: meta.name,
    reranker: name,
    candidates: rerank.candidates,
    onFailure: rerank.onFailure ?? RerankFailurePolicy.Fallback,
    source:
      reranker.decidedBy === DecidedBy.Code
        ? { kind: "code", instance: () => instance(rerank.by) as never }
        : { kind: "model", binding },
  };
}

/** The core's retrieval of a knowledge base: the tenant's (#700), reranked when it says so (#703). */
export function knowledgeRetrieveOf(
  meta: RagMeta,
  connector: RagConnector,
  reranker: BoundReranker | undefined,
): KnowledgeRetrieve {
  if (reranker === undefined) return tenantRetrieve(meta, connector);
  return async (query, { topK, signal }): Promise<KnowledgeRetrieval> => {
    const { rerankedRetrieval } = await lazyLoad(import("../rag/rerank.js"));
    const tenantId = tenantOfRetrieval(meta);
    const fetch = (k: number) => connector.retrieve(query, { topK: k, signal, tenantId });
    return rerankedRetrieval(fetch, reranker, { query, keep: topK, tenantId, signal });
  };
}

/** A reranker's spend in a tool call: its records into the call's frame, else as a cost. */
function reportRerankUsage(retrieval: KnowledgeRetrieval, reportCost: (usd: number) => void): void {
  const report = currentFrame()?.services.reportUsage;
  for (const record of retrieval.usage ?? []) {
    if (report === undefined) reportCost(record.costUsd);
    else report(record);
  }
}

const Output = z.object({
  results: z.array(
    z.object({ source: z.string(), text: z.string(), score: z.number().optional() }),
  ),
});

/** Tool mode: `search-<name>-tool(query)`; its cost is billed to `rag:<name>` (category retrieval). */
export function searchTool(
  meta: RagMeta,
  connector: RagConnector,
  reranker?: BoundReranker,
): AnyTool {
  const tool = defineTool({
    name: searchToolName(meta),
    description: `${meta.description}. ${SEARCH_TOOL_SUFFIX}`,
    input: z.object({ query: z.string().min(1) }),
    output: Output,
    run: async ({ query }, ctx) => {
      const retrieve = knowledgeRetrieveOf(meta, connector, reranker);
      const retrieval = await retrieve(query, { topK: meta.topK, signal: ctx.signal });
      ctx.reportCost(retrieval.costUsd ?? 0);
      reportRerankUsage(retrieval, ctx.reportCost);
      return {
        results: retrieval.results.map((result) => ({
          source: result.source,
          text: result.text,
          ...(result.score === undefined ? {} : { score: result.score }),
        })),
      };
    },
  });
  return { ...tool, costCaller: `rag:${meta.name}` };
}

/** Context mode: per agent, the knowledge bases the core retrieves from before the agent runs. */
export function contextSources(
  agents: readonly AgentMeta[],
  instance: (cls: Class) => unknown,
  services: WorkflowServices,
): ReadonlyMap<string, readonly KnowledgeSource[]> {
  return new Map(
    agents.map((agent) => [
      agent.name,
      (agent.rag ?? [])
        .filter((binding) => binding.mode === RagMode.Context)
        .map((binding) => {
          const meta = ragMeta(binding.use);
          const connector = instance(binding.use) as RagConnector;
          const reranker = boundRerankerOf(meta, instance, services);
          const retrieve = knowledgeRetrieveOf(meta, connector, reranker);
          return { name: meta.name, topK: meta.topK, retrieve };
        }),
    ]),
  );
}
