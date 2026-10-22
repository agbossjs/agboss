import {
  causeOfMark,
  unwindingOf,
  UNWINDING_KEY,
} from "../flow/runtime/compensation/unwinding-marks.js";
import { endedAtTake, endIfCancelled, type CancelParts } from "./cancel-requests.js";
import type { HeldExecutionLease } from "./execution-leases.js";
import { endedWithoutPass } from "./ended-tree.js";
import { treeOf } from "./tree-ends.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * Taking a tree over whose root's automatic undo was under way (#340 PR 4, AC4): its holder stopped,
 * crashed or lost the lease mid-undo, so its record is still `running` and `@agboss/unwinding` is
 * there. Whoever takes the tree's lease next — the recovery sweep (before the compatibility check:
 * the undo needs no pass, any config ends it, like #360's request), a resume — finishes the undo on
 * the checkpoint state (pending writes applied), skipping the undos marked done, then ends the tree
 * failed with the recorded reason; no pass runs. Loaded with the first take of a tree.
 */

/** Whether the tree's root undo is under way (a store error is thrown: asked again later). */
async function isUnwinding(parts: CancelParts, state: TreeState): Promise<boolean> {
  return (await unwindingOf(parts.trees, treeOf(state), UNWINDING_KEY)) !== undefined;
}

/** Finishes the tree's undo under its lease's `signal`; its final error (none: no mark). */
async function endedUnwinding(
  parts: CancelParts,
  state: TreeState,
  signal: AbortSignal,
): Promise<Error | undefined> {
  const mark = await unwindingOf(parts.trees, treeOf(state), UNWINDING_KEY);
  if (mark === undefined) return undefined;
  const text = `execution ${state.runId} is recovered: its automatic undo goes on, the undos done are skipped`;
  const subject = { executionId: state.runId, tenantId: state.tenantId };
  parts.deps.log.warn("compensation.recovered", text, subject);
  return (await endedWithoutPass(parts, state, { cause: causeOfMark(mark), signal })).error;
}

/**
 * A lease just taken (a resume, a recovery): a tree with a cancel request (#360) or an undo under
 * way is ended without a pass and the lease released; its final error, `undefined` otherwise.
 */
export async function treeEndedAtTake(
  parts: CancelParts,
  state: TreeState,
  lease: HeldExecutionLease,
): Promise<Error | undefined> {
  const cancelled = await endedAtTake(parts, state, lease);
  if (cancelled !== undefined) return cancelled;
  if (!(await isUnwinding(parts, state))) return undefined;
  try {
    return await endedUnwinding(parts, state, lease.signal);
  } finally {
    await lease.release();
  }
}

/**
 * Recovery of a root with a cancel request or an undo under way, on an instance of any config
 * version: ended when its lease is free; `true` when it had either (its holder, if any, ends it).
 */
export async function endIfEnding(parts: CancelParts, state: TreeState): Promise<boolean> {
  if (await endIfCancelled(parts, state)) return true;
  if (!(await isUnwinding(parts, state))) return false;
  const lease = await parts.leases.tryHold(treeOf(state));
  if (lease === undefined) return true;
  try {
    await endedUnwinding(parts, state, lease.signal);
  } finally {
    await lease.release();
  }
  return true;
}
