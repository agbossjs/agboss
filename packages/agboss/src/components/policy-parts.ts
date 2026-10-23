import { cascadeDefaults } from "../config/defaults.js";
import { NodeKind } from "../flow/ast.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { guardrailPartsOf, type AssembledGuardrails } from "../guardrails/assembly.js";
import { piiAssemblyOf, type AssembledPii } from "../pii/assembly.js";
import {
  toolInterceptorPartsOf,
  type AssembledToolInterceptors,
} from "../tool-interceptors/assembly.js";
import type { Class } from "./injection.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { PolicyModels } from "./model-parts.js";
import type { PromptLoader } from "./prompt-render.js";
import { workflowDeclarationOf } from "./module.js";
import type { AssembledCompactions, CompactionOwners } from "../compaction/assembly.js";
import type { UncompactedTurns } from "../compaction/compaction.decorator.js";
import type { AgentsConfigOf } from "../config/types.js";

/**
 * The workflow's policies over its application's (#120): its PII policies and its guardrails —
 * each agent's and router's lists (the levels added up, its excludes removed) and every rule they
 * break, which fails the assembly, all at once.
 */

/** What the application gives its workflows' policies: its lists and its defaults. */
export interface PolicyOwner {
  readonly piiPolicies?: readonly Class[];
  readonly guardrails?: readonly Class[];
  readonly toolInterceptors?: readonly Class[];
  readonly defaults?: WorkflowDefaults;
}

/** A workflow's policies as assembled, the classes the container creates and the models they use. */
export interface PolicyParts {
  readonly assembled: {
    readonly pii: AssembledPii;
    readonly guardrails: AssembledGuardrails;
    readonly toolInterceptors: AssembledToolInterceptors;
  };
  readonly classes: readonly Class[];
  readonly models: PolicyModels;
}

/** The workflow's PII policies: each agent's and router's list. */
export function piiPartsOf(
  bundle: WorkflowMeta,
  owner: PolicyOwner | undefined,
  agents: readonly AgentMeta[],
  graph: RuntimeGraph,
): AssembledPii {
  const routers = [...graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Router ? [node.declaration.options] : [],
  );
  const levels = [owner?.piiPolicies ?? [], bundle.piiPolicies ?? []] as const;
  const { pii, violations } = piiAssemblyOf(bundle.name, ...levels, [...agents, ...routers]);
  throwIfViolated(violations);
  return pii;
}

/** What one workflow's policies are assembled from. */
export interface PolicySources {
  readonly bundle: WorkflowMeta;
  readonly owner: PolicyOwner | undefined;
  /** The `@Workflow` class: its `defaults` as declared, cascaded over the application's here. */
  readonly workflow: Class;
  readonly agents: readonly AgentMeta[];
  readonly graph: RuntimeGraph;
  readonly loader: PromptLoader;
}

/** The workflow's PII policies and guardrails (`defaults.guardrail.model` of its cascade). */
export async function policyPartsOf(sources: PolicySources): Promise<PolicyParts> {
  const { bundle, owner, agents, graph } = sources;
  const pii = piiPartsOf(bundle, owner, agents, graph);
  const { options } = workflowDeclarationOf(sources.workflow);
  const defaults = cascadeDefaults(owner?.defaults, options.defaults);
  const owners = {
    application: owner?.guardrails ?? [],
    workflow: bundle.guardrails ?? [],
    workflowName: bundle.name,
    defaultModel: defaults?.guardrail?.model,
  };
  const guardrails = await guardrailPartsOf(owners, agents, graph, sources.loader);
  const guardrailClasses = guardrails.guardrails.map((guardrail) => guardrail.type);
  const toolInterceptors = toolInterceptorPartsOf(
    {
      application: owner?.toolInterceptors ?? [],
      workflow: bundle.toolInterceptors ?? [],
      workflowName: bundle.name,
    },
    agents,
  );
  const interceptorClasses = toolInterceptors.interceptors.map((interceptor) => interceptor.type);
  return {
    assembled: { pii, guardrails, toolInterceptors },
    classes: [...pii.classes, ...guardrailClasses, ...interceptorClasses],
    models: { pii: pii.detectors, guardrails: guardrails.guardrails },
  };
}

/**
 * A workflow's compactions over its application's (#120 PR 3), for `workflowOf`: their assembly
 * loads on first use (QUALITY.md — it is not needed at import time) and gives the config's
 * `compactions`, the settings a profile may change.
 */

/** The config's `compactions` of the workflow's compactions in use. */
export interface CompactionConfigPart {
  readonly settings: NonNullable<AgentsConfigOf<string>["compactions"]>;
}

/** What the application gives its workflows' memory: its compaction and its window. */
interface CompactionOwner {
  readonly compaction?: Class;
  readonly uncompactedTurns?: UncompactedTurns;
}

/** What one workflow's compactions are assembled from. */
export interface CompactionSources {
  readonly bundle: WorkflowMeta;
  readonly owner: CompactionOwner | undefined;
  readonly agents: readonly AgentMeta[];
  readonly graph: RuntimeGraph;
  readonly loader: PromptLoader;
}

/** The compaction settings of the workflow and of its application. */
const ownersOf = (bundle: WorkflowMeta, owner: CompactionOwner | undefined): CompactionOwners => ({
  ...(owner === undefined
    ? {}
    : { application: { compaction: owner.compaction, uncompactedTurns: owner.uncompactedTurns } }),
  workflow: {
    name: bundle.name,
    compaction: bundle.compaction,
    uncompactedTurns: bundle.uncompactedTurns,
  },
});

/** The workflow's compactions and their config settings; a broken rule fails the assembly. */
export async function compactionsFor(
  sources: CompactionSources,
): Promise<AssembledCompactions & CompactionConfigPart> {
  const { compactionPartsOf, compactionSettingsOf } = await import("../compaction/assembly.js");
  const { bundle, owner, agents, graph, loader } = sources;
  const compactions = await compactionPartsOf(ownersOf(bundle, owner), agents, graph, loader);
  return { ...compactions, settings: compactionSettingsOf(compactions) };
}
