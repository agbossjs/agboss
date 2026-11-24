import { isUnwinding } from "../flow/runtime/compensation/unwinding-marks.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { frozenOutputOf } from "./external-pause.js";
import { treeOf } from "./tree-ends.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import type { ExecutionOutput } from "./types.js";

/**
 * What ends a tree at a lease take, the one place a resume, a recovery and an expiry all pass: a
 * cancel or stop request (#360, #1341b) ends it as cancelled or stopped; an undo under way (#340
 * PR 4) is finished; a tree paused from outside (#1341c) rests with its output — the answer that
 * brought the take stays recorded and the sweep's wake takes it after the unpause. The lease is
 * released when the tree ended; `undefined` otherwise, the take goes on.
 */
export async function endedAtTakeOf(
  parts: TreeMoveParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<ExecutionOutput | Error | undefined> {
  const { endedAtTake } = await lazyLoad(import("./cancel-requests.js"));
  const cancelled = await endedAtTake(parts, state, lease);
  if (cancelled !== undefined) return cancelled;
  if (await isUnwinding(parts.trees, treeOf(state))) {
    const { endedUnwindingAtTake } = await lazyLoad(import("./unwinding-takeover.js"));
    return endedUnwindingAtTake(parts, state, lease);
  }
  return frozenOutputOf(parts, state, lease);
}
