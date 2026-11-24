import { InterruptKind, interruptErrorOf } from "./interrupt-requests.js";
import type { InterruptMode } from "./interrupt-types.js";
import { CompensationFailedError } from "../flow/compensation.js";
import { writeCancelRequest, type CancelParts } from "./cancel-requests.js";
import { endedWithoutPass, rootRecordOf } from "./ended-tree.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { ThreadKey } from "./live-runs.js";
import { treeOf } from "./tree-ends.js";
import { LeaseTakeoverReason } from "../infrastructure/execution-audit-log.repository.js";
import { rootTakeOf } from "./execution-leases.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { TreeState } from "./tree-move-types.js";

/** Who asked for the cancel or stop, why, and (a stop's) how: `app.cancel` / `app.stop` options. */
export interface CancelCommand {
  readonly ownerId?: string | undefined;
  readonly reason?: string | undefined;
  /** `Stop` (#1341b): the tree is stopped, nothing undone; absent: cancelled. */
  readonly kind?: InterruptKind | undefined;
  readonly mode?: InterruptMode | undefined;
}

/** The status of a cancelled root (text: a record's status may be compared with it). */
const CANCELLED: string = ExecutionRecordStatus.Cancelled;
const STOPPED: string = ExecutionRecordStatus.Stopped;

/**
 * `app.cancel` of a thread whose tree rests paused on this application (#340 PR 3, Q6): under the
 * tree's lease its paused run is dropped — its pauses withdrawn first (#337) — then its open
 * undoable actions are undone (each bounded by `compensationTimeout`) while its record is `running`
 * (S7 3), then its record is failed as cancelled, its keys removed and `onExecutionError` observed.
 * The cancel returns after the undo; `false` when the thread rests paused no more. An undo that
 * failed — the others ran — rejects the cancel with `CompensationFailedError`, its cause the
 * `ExecutionCancelledError` (S7 1). With `runId`, only that execution's paused run (#807).
 */
export async function cancelledPaused(
  parts: CancelParts,
  thread: ThreadKey,
  runId?: string,
  command?: CancelCommand,
): Promise<boolean> {
  const { deps, paused, leases } = parts;
  const found = await paused.find(thread);
  if (found === undefined) return false;
  // a cancel of one execution (#807) holds that tree's lease and ends that run only — never
  // another run of its thread, paused before the look or since
  const tree = { ...thread, runId: runId ?? found.run.runId };
  // Stryker disable next-line LogicalOperator: only the ids of this state are read before the end below, which reads the version of the run it finds again
  const startedVersion = found.run.startedVersion ?? deps.config.version;
  // the mark first (#909): from here on no effect of the tree but its undo's is accepted; and the
  // tree key (#1073), the one request an expiry's holder or a lease taken over reads
  const requested = { tenantId: thread.tenantId, rootExecutionId: tree.runId };
  await requestedBy(parts, requested, thread, command);
  const take = rootTakeOf(deps.pause, tree.runId, LeaseTakeoverReason.Cancelled);
  const lease = await leases.hold(treeOf({ ...tree, startedVersion }), undefined, take);
  try {
    // a holder moved it meanwhile — not paused any more, or another run of the thread paused
    // since: the caller asks its holder instead. The run is read, not dropped: the end below
    // marks the tree unwinding and moves its record off `paused` first, then drops the run and
    // closes its pauses (#1132) — an instance that dies between any two of these leaves a tree
    // the recovery sweep or a second cancel finishes, never a pause open under a run that is gone
    const run = (await paused.find(thread))?.run;
    if (run?.runId !== tree.runId)
      return await endedAsCancelled(parts, { ...tree, startedVersion }, requested);
    const state = { ...tree, startedVersion: run.startedVersion ?? deps.config.version };
    const cause = pausedCauseOf(command, thread);
    const ended = await endedWithoutPass(parts, state, { cause, signal: lease.signal, lease });
    if (ended.error instanceof CompensationFailedError) throw ended.error;
    return true;
  } finally {
    await lease.release();
  }
}

/** Why a paused tree ends: the cancel or stop of `command` (a cancel when it names no kind). */
const pausedCauseOf = (command: CancelCommand | undefined, thread: ThreadKey) =>
  interruptErrorOf(
    { kind: command?.kind ?? InterruptKind.Cancel, reason: command?.reason },
    thread.threadId,
    " while paused",
  );

/** The cancel's request written for `thread`: its mark and key, and its row of the status history. */
const requestedBy = (
  parts: CancelParts,
  tree: ExecutionTree,
  thread: ThreadKey,
  command: CancelCommand | undefined,
): Promise<void> =>
  writeCancelRequest(parts, tree, {
    requestedAt: parts.clock.now().toISOString(),
    ownerId: command?.ownerId ?? null,
    threadId: thread.threadId,
    reason: command?.reason,
    ...(command?.kind === undefined ? {} : { kind: command.kind, mode: command.mode }),
  });

/**
 * A holder moved the tree while this cancel waited for its lease (#1073): when it ended the tree
 * as cancelled — it read this request — the cancel did its job; when the tree ended otherwise the
 * request is withdrawn (it goes with the tree's keys) and the cancel was too late.
 */
async function endedAsCancelled(
  parts: CancelParts,
  state: TreeState,
  tree: ExecutionTree,
): Promise<boolean> {
  const record = await rootRecordOf(parts.deps, state);
  if (record === undefined || record.status === "running" || record.status === "paused")
    return false;
  await parts.trees.deleteAllInTree(tree);
  return CANCELLED === record.status || STOPPED === record.status;
}
