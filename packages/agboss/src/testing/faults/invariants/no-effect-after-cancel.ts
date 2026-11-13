import type { FaultRun } from "../facts.js";
import { compareAt } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";
import { cancelAnchorOf, effectsOf } from "./a2a-cancels.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * No effect after a durable cancel (#909), on the store's own history, for every tree of every run:
 * once a tree's `requestCancel` answered, no fenced write ran, no payment intent was recorded and no
 * new attempt claimed by a store operation invoked after it — except its undo's, the cancel's own
 * unwinding. An operation already open when the cancel was asked may commit: it was invoked first.
 */

/** The trees whose cancel was made durable in `run`: their roots. */
const cancelledTreesOf = (run: FaultRun): readonly string[] => [
  ...new Set(
    run.history.operations.flatMap(({ invoke }) =>
      invoke.operation === StoreHoldPoint.LeaseRequestCancel && invoke.key !== undefined
        ? [invoke.key]
        : [],
    ),
  ),
];

/** Every effect a tree committed after its cancel was durable. */
export function noEffectAfterCancelViolations(run: FaultRun): FaultViolation[] {
  return cancelledTreesOf(run).flatMap((root) => {
    const anchor = cancelAnchorOf(run, root);
    if (anchor === undefined) return [];
    return effectsOf(run, root)
      .filter(({ invoke }) => compareAt(invoke.at, anchor) > 0)
      .map(({ invoke }) =>
        violation(
          FaultInvariant.NoEffectAfterCancel,
          `tree ${root} committed ${invoke.operation} (${invoke.process}) after its cancel was durable`,
        ),
      );
  });
}
