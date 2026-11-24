import type { FrameLease } from "../flow/context/frame.js";
import { ExecutionCancelledError } from "../core/errors.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { runningOutcome } from "../run/execute.js";
import type { Turn, TurnOutcome } from "../turns/index.js";
import type { AppDeps } from "./app-deps.js";
import { cancelledRecordOutcome } from "./live-runs.js";
import { isStop, reasonOfError, STOPPED_STOP_REASON } from "./interrupt-requests.js";
import { executionEventAt } from "./run-events.js";
import { forgetTree } from "./tree-ends.js";
import { historyEndOf, keepExecutionRecord } from "./execution-history.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import { undoneTreeEnd, type EndedTreeUndo } from "./tree-unwind.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { leaseScope } from "./lease-scope.js";
import { lostRunUsageOf, tallyLostRun } from "./lost-attempt.js";
import { cancelledOutputOf } from "./cancelled-output.js";
import { ExecutionStatus } from "./types.js";
import type { CancelledExecutionOutput, StoppedExecutionOutput } from "./types.js";

/**
 * Ending a tree without a pass, under its lease (#360's cancel request, `app.cancel` of a paused
 * tree, #340 PR 4's interrupted undo): its undo is marked under way and its record is `running`
 * while it runs (#340 S7 3: a crash mid-undo is found by the recovery sweep), its paused run dropped
 * (its pauses withdrawn, #337), its open undoable actions undone, then its record ended — cancelled,
 * or failed with `CompensationFailedError` when an undo failed —, its keys and pauses forgotten and
 * `onExecutionCancel` (`onExecutionError` for a failure) observed once, only when this call ended
 * the record. A cancel is an outcome, not an error: it is reported as a cancelled output (#1341).
 */

/** What ending a tree without a pass needs from its workflow's app. */
export type EndedTreeParts = Pick<TreeMoveParts, "deps" | "paused" | "trees" | "clock">;

/**
 * The root's record, by its id (#808: however many later turns its thread has); `undefined` when it
 * has none on its thread.
 */
export async function rootRecordOf(deps: AppDeps, state: TreeState): Promise<Turn | undefined> {
  const record = await deps.turns.findByTenantIdAndRunId(state.tenantId, state.runId);
  return record?.threadId === state.threadId ? record : undefined;
}

/** The record's outcome for the tree's final error: a cancel, or what ended it. */
function endedOutcomeOf(record: Turn, error: Error): TurnOutcome {
  const outcome = cancelledRecordOutcome(record.route, record.costUsd);
  if (isStop(error)) return { ...outcome, status: "stopped", stopReason: STOPPED_STOP_REASON };
  return error instanceof ExecutionCancelledError
    ? outcome
    : { ...outcome, status: "failed", stopReason: error.message };
}

/** Fails a `running` or `paused` record; `true` when this call did (it is the one). */
async function failedRecord(deps: AppDeps, record: Turn, error: Error): Promise<boolean> {
  const outcome = endedOutcomeOf(record, error);
  // the operator's reason goes to the thread's status history with the record's end (#1341d)
  const context = { reason: reasonOfError(error) };
  return (
    (await deps.turns.completeIfStatus(
      record.id,
      ExecutionRecordStatus.Running,
      outcome,
      context,
    )) ||
    (await deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, outcome, context))
  );
}

/** How a tree ended without a pass: its final error, and whether this call ended its record. */
export interface EndedTree {
  readonly error: Error;
  readonly isEnded: boolean;
  /** The cancelled or stopped output, when the tree's final error is that (not an undo that failed). */
  readonly output?: CancelledExecutionOutput | StoppedExecutionOutput;
}

/** Why and under what the tree ends: its cause, and the signal its undo stops on. */
export interface TreeEnd {
  readonly cause: Error;
  readonly signal: AbortSignal;
  /** The lease the undo runs under: its actions fence with it (#471). */
  readonly lease: FrameLease;
  /** Where what the undo ran goes, for a caller that keeps the record again (#635). */
  readonly undo?: EndedTreeUndo;
}

/** Ends the tree as described above. */
export async function endedWithoutPass(
  parts: EndedTreeParts,
  state: TreeState,
  end: TreeEnd,
): Promise<EndedTree> {
  const { deps } = parts;
  const undo: EndedTreeUndo = end.undo ?? {};
  // up to and including the failed record, the lease is held (#928): an unanswered call there hands
  // over; the cleanup after it (kept record, keys, observers) stays outside
  const { lost, ended, isEnded } = await leaseScope(end.lease, () =>
    endedUnderLease(parts, state, { ...end, undo }),
  );
  const error: Error = ended;
  // its undo ran here without a pass: the record lists what ran, as the event does (#484); kept
  // before the tree is forgotten (#699): a pod killed in the cleanup's round trips keeps it
  const { compensations } = undo;
  if (isEnded) await keepExecutionRecord(deps, state, historyEndOf(error, compensations, lost));
  if (isEnded) tallyLostRun(deps, state, lost);
  // read before the tree's keys go: what it spent and undid, as the caller and the event report it
  const output =
    error instanceof ExecutionCancelledError
      ? await cancelledOutputOf(deps, state, { cause: error, compensations, lostUsage: lost })
      : undefined;
  await forgetTree(parts, state, error);
  if (isEnded) {
    const event = executionEventAt(state, deps);
    if (output === undefined)
      await deps.observer.onExecutionError({ ...event, error, compensations: compensations ?? [] });
    else if (output.status === ExecutionStatus.Stopped)
      await deps.observer.onExecutionStop({ ...event, reason: output.reason, spend: output.spend });
    else
      await deps.observer.onExecutionCancel({
        ...event,
        compensations: output.compensations,
        spend: output.spend,
        reason: output.reason,
      });
  }
  return output === undefined ? { error, isEnded } : { error, isEnded, output };
}

/** The part of the end that runs under the lease: the undo and the record's failure. */
async function endedUnderLease(
  parts: EndedTreeParts,
  state: TreeState,
  end: TreeEnd & { readonly undo: EndedTreeUndo },
) {
  const { deps, paused } = parts;
  const record = await rootRecordOf(deps, state);
  // a run no recovery continues lost its pass (#860 D1): read before its tree's keys go
  const lost = await lostRunUsageOf(parts, state);
  const { markTreeUnwinding } = await lazyLoad(import("./compensation/root-unwind.js"));
  await markTreeUnwinding(deps, state, end.cause);
  if (record !== undefined) {
    const running = runningOutcome(record.route, record.costUsd);
    await deps.turns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, running);
  }
  const stored = await paused.find(state);
  if (stored?.run.runId === state.runId) await paused.drop(state, state.runId, end.cause);
  const failure = { error: end.cause, signal: end.signal, lease: end.lease };
  const ended = await undoneTreeEnd(deps, state, failure, end.undo);
  const isEnded = record !== undefined && (await failedRecord(deps, record, ended));
  return { record, lost, ended, isEnded };
}
