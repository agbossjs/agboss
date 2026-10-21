import { cascadeDefaults } from "../config/defaults.js";
import { NodeKind } from "../flow/ast.js";
import type { WorkflowDefaults } from "../flow/decorators/workflow.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { guardrailPartsOf, type AssembledGuardrails } from "../guardrails/assembly.js";
import { piiAssemblyOf, type AssembledPii } from "../pii/assembly.js";
import type { Class } from "./injection.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { PolicyModels } from "./model-parts.js";
import type { PromptLoader } from "./prompt-render.js";
import { workflowDeclarationOf } from "./module.js";

/**
 * The workflow's policies over its application's (#120): its PII policies and its guardrails —
 * each agent's and router's lists (the levels added up, its excludes removed) and every rule they
 * break, which fails the assembly, all at once.
 */

/** What the application gives its workflows' policies: its lists and its defaults. */
export interface PolicyOwner {
  readonly piiPolicies?: readonly Class[];
  readonly guardrails?: readonly Class[];
  readonly defaults?: WorkflowDefaults;
}

/** A workflow's policies as assembled, the classes the container creates and the models they use. */
export interface PolicyParts {
  readonly assembled: { readonly pii: AssembledPii; readonly guardrails: AssembledGuardrails };
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
  return {
    assembled: { pii, guardrails },
    classes: [...pii.classes, ...guardrailClasses],
    models: { pii: pii.detectors, guardrails: guardrails.guardrails },
  };
}
