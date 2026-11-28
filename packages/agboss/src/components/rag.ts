import { ConfigError } from "../core/error-families/config-errors.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { RagRuntime } from "../rag/rag-source.js";
import type { RecordedRerankerMeta } from "../rag/reranker.decorator.js";
import { RerankFailurePolicy, type KnowledgeSource } from "../rag/types.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { AgentsConfigOf } from "../config/types.js";
import type { Class, Token } from "./injection.js";
import { componentOf, requireComponent } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";

export type RagMeta = Extract<ReturnType<typeof componentOf>, { kind: "rag" }>["meta"];

/** `[agent.duplicate-rag]`: one `@Rag` listed twice in one agent's `rag`. */
const duplicateRagViolations = (agents: readonly AgentMeta[]): RuleViolation[] =>
  agents.flatMap((agent) => {
    const twice = agent.rag?.filter((cls, index, rags) => rags.indexOf(cls) !== index) ?? [];
    return [...new Set(twice)].map((cls) =>
      violation(
        "agent.duplicate-rag",
        `@Agent "${agent.name}": ${cls.name} is listed twice in rag — list it once`,
        [agent.name],
      ),
    );
  });

/**
 * The `@Rag` classes of a workflow, checked: the agents' `rag` (context injection) and the ones the
 * workflow's tools inject (`deps`), each once.
 */
export function ragClassesOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  tools?: readonly Class[],
): Class[] {
  const duplicates = duplicateRagViolations(agents);
  if (duplicates.length > 0) throw new ConfigError.GraphRules({ violations: duplicates });
  const listed = agents.flatMap((agent) => agent.rag ?? []);
  for (const cls of listed) {
    if (componentOf(cls)?.kind !== "rag") {
      throw new ConfigError.Component({
        message: `@Workflow "${bundle.name}": ${cls.name} in an agent's rag is not a @Rag`,
      });
    }
  }
  const injected =
    tools?.flatMap((cls) => {
      const found = componentOf(cls);
      const deps: readonly Token[] | undefined =
        found?.kind === "tool" ? found.meta.deps : undefined;
      return deps?.filter(isRagClass) ?? [];
    }) ?? [];
  return [...new Set([...listed, ...injected])];
}

/** Whether a dependency is a `@Rag` class: a token that is no class has no record, as a class that is none. */
const isRagClass = (dep: Token): dep is Class => componentOf(dep)?.kind === "rag";

export const ragMeta = (cls: Class): RagMeta => requireComponent(cls, "rag", "workflowOf").meta;

/** The `@Rag` classes the workflow uses: scope declared, reranking checked (lazily). */
export async function checkedRagClassesOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
  tools?: readonly Class[],
): Promise<Class[]> {
  const rags = ragClassesOf(bundle, agents, tools);
  if (rags.length > 0) (await lazyLoad(import("../rag/rag-checks.js"))).checkRags(rags);
  return rags;
}

/** A knowledge base's reranking as its config entry says it. */
export interface RagRerankSetting {
  readonly reranker: string;
  readonly candidates: number;
  readonly onFailure: RerankFailurePolicy;
}

/** A knowledge base's reranker class and its meta; none without `reranker`, or when it is no reranker. */
export const rerankedBy = (
  meta: RagMeta,
): { readonly cls: Class; readonly meta: RecordedRerankerMeta } | undefined => {
  const { reranker } = meta;
  if (reranker === undefined) return undefined;
  const found = componentOf(reranker);
  return found?.kind === "reranker" ? { cls: reranker, meta: found.meta } : undefined;
};

/** A knowledge base's reranking for describe and `configHash`. */
const rerankSettingOf = (meta: RagMeta): { readonly rerank?: RagRerankSetting } => {
  const reranked = rerankedBy(meta);
  if (reranked === undefined) return {};
  const { name, candidates, onFailure = RerankFailurePolicy.FailStep } = reranked.meta;
  return { rerank: { reranker: name, candidates, onFailure } };
};

/** An agent's knowledge bases as config entries (describe, profiles, `configHash`). */
export const ragSettings = (
  agent: AgentMeta,
): AgentsConfigOf<string>["agents"][string]["rag"] & {} =>
  (agent.rag ?? []).map((cls) => {
    const meta = ragMeta(cls);
    const { name, topK, scope } = meta;
    return { name, topK, scope, ...rerankSettingOf(meta) };
  });

/** The `@RagReranker` classes of knowledge bases, for the container. */
export const rerankerClassesOf = (rags: readonly Class[]): Class[] =>
  rags.flatMap((cls) => {
    const reranker = ragMeta(cls).reranker;
    return reranker === undefined ? [] : [reranker];
  });

/** Context mode: per agent, the knowledge bases the core retrieves from before the agent runs. */
export function contextSources(
  agents: readonly AgentMeta[],
  runtimeOf: (cls: Class) => RagRuntime,
): ReadonlyMap<string, readonly KnowledgeSource[]> {
  return new Map(
    agents.map((agent) => [
      agent.name,
      (agent.rag ?? []).map((cls): KnowledgeSource => {
        const { name, topK, retrieve } = runtimeOf(cls);
        return { name, topK, retrieve };
      }),
    ]),
  );
}
