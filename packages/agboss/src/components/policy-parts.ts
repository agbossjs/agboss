import { cascadeDefaults } from "../config/defaults.js";
import { NodeKind } from "../flow/ast.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { guardrailPartsOf, type AssembledGuardrails } from "../guardrails/assembly.js";
import { piiAssemblyOf, type AssembledPii } from "../pii/assembly.js";
import { inheritedPiiOf } from "../pii/inheritance.js";
import {
  toolInterceptorPartsOf,
  type AssembledToolInterceptors,
  type ToolInterceptorOwners,
} from "../tool-interceptors/assembly.js";
import type { Class } from "./injection.js";
import type { ModelResolver } from "../models/model-resolver.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { PolicyModels } from "./model-parts.js";
import type { PromptLoader } from "./prompt-render.js";
import { workflowDeclarationOf } from "./module.js";
import type { AssembledMemories } from "../memory/assembly.js";
import type { AgentsConfigOf } from "../config/types.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The workflow's policies over its application's (#120): its PII policies and its guardrails —
 * each agent's and router's lists (the levels added up, its excludes removed) and every rule they
 * break, which fails the assembly, all at once.
 */

/** What the application gives its workflows' policies: its lists and its defaults. */
export interface PolicyOwner {
  readonly piiPolicies?: readonly Class[];
  /** The application's workflows: the ways into a child, for what it inherits (#1150). */
  readonly workflows?: readonly Class[];
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
  resolver?: ModelResolver,
): AssembledPii {
  const routers = [...graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Router ? [node.declaration.options] : [],
  );
  const { pii, violations } = piiAssemblyOf({
    workflowName: bundle.name,
    application: owner?.piiPolicies ?? [],
    workflow: bundle.piiPolicies ?? [],
    workflowExcludes: bundle.excludePiiPolicies,
    elements: [...agents, ...routers],
    // what a child inherits on each static way into it (#1150)
    inherited: inheritedPiiOf(owner?.workflows, graph.type),
    resolver,
  });
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
  /** Resolves the models of the workflow's policies through its model cascade (#1313). */
  readonly resolver?: ModelResolver;
}

/** The levels above the agents that list tool interceptors: the application's and the workflow's. */
const interceptorOwnersOf = (
  bundle: PolicySources["bundle"],
  owner: PolicyOwner | undefined,
): ToolInterceptorOwners => ({
  application: owner?.toolInterceptors ?? [],
  workflow: bundle.toolInterceptors ?? [],
  workflowExcludes: bundle.excludeToolInterceptors ?? [],
  workflowName: bundle.name,
});

/** The workflow's PII policies and guardrails (`defaults.guardrail.model` of its cascade). */
export async function policyPartsOf(sources: PolicySources): Promise<PolicyParts> {
  const { bundle, owner, agents, graph } = sources;
  const pii = piiPartsOf(bundle, owner, agents, graph, sources.resolver);
  const { options } = workflowDeclarationOf(sources.workflow);
  const defaults = cascadeDefaults(owner?.defaults, options.defaults);
  const owners = {
    application: owner?.guardrails ?? [],
    workflow: bundle.guardrails ?? [],
    workflowName: bundle.name,
    defaultModel: defaults?.guardrail?.model,
    resolver: sources.resolver,
  };
  const guardrails = await guardrailPartsOf(owners, agents, graph, sources.loader);
  const guardrailClasses = guardrails.guardrails.map((guardrail) => guardrail.type);
  const toolInterceptors = toolInterceptorPartsOf(interceptorOwnersOf(bundle, owner), agents);
  const interceptorClasses = toolInterceptors.interceptors.map((interceptor) => interceptor.type);
  return {
    assembled: { pii, guardrails, toolInterceptors },
    classes: [...pii.classes, ...guardrailClasses, ...interceptorClasses],
    models: { pii: pii.detectors, guardrails: guardrails.guardrails },
  };
}

/**
 * A workflow's memories (#1303), for `workflowOf`: their assembly loads on first use (QUALITY.md — it
 * is not needed at import time) and gives the config's `compactions`, the settings a profile may change.
 */

/** The config's `compactions` of the workflow's memories in use. */
export interface CompactionConfigPart {
  readonly settings: NonNullable<AgentsConfigOf<string>["compactions"]>;
}

/** What one workflow's memories are assembled from. */
export interface MemorySources {
  readonly bundle: WorkflowMeta;
  readonly agents: readonly AgentMeta[];
  readonly graph: RuntimeGraph;
  readonly loader: PromptLoader;
}

/** The workflow's memories and their config settings; a broken rule fails the assembly. */
export async function memoriesFor(
  sources: MemorySources,
): Promise<AssembledMemories & CompactionConfigPart> {
  const { memoryPartsOf, compactionSettingsOf } = await lazyLoad(import("../memory/assembly.js"));
  const { bundle, agents, graph, loader } = sources;
  const memories = await memoryPartsOf(
    { workflow: { name: bundle.name, memory: bundle.memory } },
    agents,
    graph,
    loader,
  );
  return { ...memories, settings: compactionSettingsOf(memories) };
}
