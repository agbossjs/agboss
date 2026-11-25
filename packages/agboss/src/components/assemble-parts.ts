import { businessKeyWriterPartOf } from "./container/fenced-reach.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { Class } from "./injection.js";
import type { WorkflowMeta } from "./meta-types.js";
import { containerFor, providerModulesOf } from "./runtime.js";
import { dependencyTree } from "./container/graph-check.js";

/** The parts of a workflow whose instances come from its container (per `services`). */
export type ContainerParts = Pick<AssembledWorkflow, "resolve" | "businessKeyWriter">;

/** A component of a workflow by its class, created by its container (guardrails, policies, …). */
export function containerPartsOf(bundle: WorkflowMeta): ContainerParts {
  const get = (services: WorkflowServices, cls: Class): unknown =>
    containerFor(bundle, services).get(cls);
  return { resolve: (services) => (cls) => get(services, cls), ...businessKeyWriterPartOf(bundle) };
}

/** Each tool's dependency tree by tool name (tools without dependencies are left out). */
export const toolDependenciesOf = (
  bundle: WorkflowMeta,
  tools: readonly Class[],
  names: ReadonlyMap<Class, string>,
): Record<string, string> =>
  Object.fromEntries(
    tools.flatMap((cls) => {
      const tree = dependencyTree(cls, providerModulesOf(bundle));
      return tree === "" ? [] : [[names.get(cls) ?? cls.name, tree] as const];
    }),
  );
