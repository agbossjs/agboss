import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { isCancelMarked } from "./cancel-marks.js";
import { endCancelled, type CancelParts, type SweptRoot } from "./cancel-requests.js";
import { rootTakeOf } from "./execution-leases.js";
import type { TreeState } from "./tree-move-types.js";
import { treeOf } from "./tree-ends.js";

/** The status of a root that rests (a record's status is text: it may be compared with this). */
export const RESTING: string = ExecutionRecordStatus.Paused;

/**
 * A resting tree whose cancel was requested and never finished (#1152): `app.cancel` writes its
 * request — the lease row's mark, then the tree key — before it moves the root's record, so an
 * instance that died in between leaves a tree resting `paused` that nothing visits. The sweep
 * reads the mark; a root it carries is ended here exactly as `app.cancel` ends it
 * (`endCancelled`: the same record states, events, closed pauses and children), under the tree's
 * lease, taken only when free. `true` when it ended the tree, `false` when there was nothing to do
 * (no mark, the tree no longer rests, its lease is held elsewhere — a later look). Idempotent: of
 * two sweeps, or a sweep and a retried cancel, the second finds the record moved and does nothing
 * (the end itself fails a record only once).
 */
export async function endRestingCancelled(
  parts: CancelParts,
  state: TreeState & SweptRoot,
): Promise<boolean> {
  const { deps, leases } = parts;
  const tree = treeOf(state);
  if (!(await isCancelMarked(leases, tree))) return false;
  const isResting = async (): Promise<boolean> =>
    (await deps.turns.byIds([state.turnId]))[0]?.status === RESTING;
  // not resting any more — a cancel finished its end since the look read the record, or a holder
  // moved it: no lease asked for, or the one given released at once (the take reads it before and
  // after the store), so the end is never run twice
  const take = {
    ...rootTakeOf(deps.pause, state.runId, LeaseTakeoverReason.Cancelled),
    isOver: async () => !(await isResting()),
  };
  const lease = await leases.tryHold(tree, take);
  if (lease === undefined) return false;
  try {
    await endCancelled(parts, state, lease);
    return true;
  } finally {
    await lease.release();
  }
}
