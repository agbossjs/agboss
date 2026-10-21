import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { Class } from "./injection.js";
import type { WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** The parts of a workflow whose instances come from its container (per `services`). */
export type ContainerParts = Pick<AssembledWorkflow, "resolve">;

/** A component of a workflow by its class, created by its container (guardrails, policies, …). */
export function containerPartsOf(bundle: WorkflowMeta): ContainerParts {
  const get = (services: WorkflowServices, cls: Class): unknown =>
    containerFor(bundle, services).get(cls);
  return { resolve: (services) => (cls) => get(services, cls) };
}
