import {
  causeOfMark,
  unwindingOf,
  UNWINDING_KEY,
} from "../flow/runtime/compensation/unwinding-marks.js";
import type { CancelParts } from "./cancel-requests.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { endedWithoutPass } from "./ended-tree.js";
import { treeOf } from "./tree-ends.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * Taking a tree over whose root's automatic undo was under way (#340 PR 4, AC4): its holder stopped,
 * crashed or lost the lease mid-undo, so its record is still `running` and `@agboss/unwinding` is
 * there (`isUnwinding`, read by `tree-moves.ts` at every take). Whoever takes the tree's lease next
 * — the recovery sweep (before the compatibility check: the undo needs no pass, any config ends it,
 * like #360's request), a resume — finishes the undo on the checkpoint state (pending writes
 * applied), skipping the undos marked done, then ends the tree failed with the recorded reason; no
 * pass runs. Loaded only when a tree has the mark.
 */

/** Finishes the tree's undo under its lease's `signal`; its final error (none: no mark). */
async function endedUnwinding(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<Error | undefined> {
  const mark = await unwindingOf(parts.trees, treeOf(state), UNWINDING_KEY);
  if (mark === undefined) return undefined;
  const text = `execution ${state.runId} is recovered: its automatic undo goes on, the undos done are skipped`;
  const subject = { executionId: state.runId, tenantId: state.tenantId };
  parts.deps.log.warn("compensation.recovered", text, subject);
  const end = { cause: causeOfMark(mark), signal: lease.signal, lease };
  return (await endedWithoutPass(parts, state, end)).error;
}

/** A lease just taken of a tree with the mark: the tree ended, the lease released; its final error. */
export async function endedUnwindingAtTake(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<Error | undefined> {
  try {
    return await endedUnwinding(parts, state, lease);
  } finally {
    await lease.release();
  }
}

/**
 * Recovery of a root with the mark, on an instance of any config version: ended when its lease is
 * free; `true` either way (its holder, if any, ends it).
 */
export async function endUnwindingIfFree(parts: CancelParts, state: TreeState): Promise<boolean> {
  const lease = await parts.leases.tryHold(treeOf(state));
  if (lease !== undefined) await endedUnwindingAtTake(parts, state, lease);
  return true;
}
