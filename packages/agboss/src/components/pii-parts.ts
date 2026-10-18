import { NodeKind } from "../flow/ast.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { piiAssemblyOf, type AssembledPii } from "../pii/assembly.js";
import type { Class } from "./injection.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";

/**
 * The workflow's PII policies over its application's (#120): each agent's and router's list (the
 * levels added up, its excludes removed) and every rule they break — which fails the assembly,
 * all at once.
 */
export function piiPartsOf(
  bundle: WorkflowMeta,
  owner: { readonly piiPolicies?: readonly Class[] } | undefined,
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
