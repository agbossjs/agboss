import { childClassesOf } from "../flow/analyse/child-workflow.js";
import { isThisWorkflow } from "../flow/this-workflow.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { handedDownPiiOf, type FingerprintDeps } from "./fingerprints.js";

/** What the handed-down part is made from: the workflow's flow and its PII policies. */
export interface HandedDownSource {
  readonly graph: RuntimeGraph;
  readonly pii?: FingerprintDeps["pii"];
}

/**
 * The PII policies a workflow's children inherit from it (#1150), only where it launches another
 * workflow and the application or it lists one, so every other workflow keeps its hash. Each child's
 * own snapshot is as declared; this is what makes every policy at a child's models part of its root's
 * `configHash`, whether or not the workflow that lists it has an element of its own.
 */
export function handedDownSnapshot(deps: HandedDownSource): object {
  const launchesAnother = childClassesOf(deps.graph.flow).some(
    (workflow) => workflow !== deps.graph.type && !isThisWorkflow(workflow),
  );
  if (!launchesAnother) return {};
  const policies = handedDownPiiOf(deps.pii);
  return policies.length === 0 ? {} : { handedDown: policies };
}
