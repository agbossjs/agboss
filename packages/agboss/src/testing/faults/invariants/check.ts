import type { FaultRun } from "../facts.js";
import { effectsOnceViolations } from "./effects-once.js";
import { oneOwnerViolations } from "./one-owner.js";
import { treeViolations } from "./trees.js";
import { FaultInvariantError, type FaultViolation } from "./violations.js";

/**
 * The invariant checker of the fault suite (#484): every invariant on one run — read through the
 * public API and the store history only — and the run's violations, each named.
 */

/** Every violation of every invariant in `run`. */
export const faultViolationsOf = (run: FaultRun): readonly FaultViolation[] => [
  ...oneOwnerViolations(run),
  ...effectsOnceViolations(run),
  ...treeViolations(run),
];

/** Throws `FaultInvariantError` with every violation when `run` broke an invariant. */
export function assertFaultInvariants(scenario: string, run: FaultRun): void {
  const violations = faultViolationsOf(run);
  if (violations.length > 0) throw new FaultInvariantError(scenario, violations);
}
