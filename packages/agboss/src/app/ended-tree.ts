import type { FrameLease } from "../flow/context/frame.js";
import { ExecutionCancelledError } from "../core/errors.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { runningOutcome } from "../run/execute.js";
import type { Tern, TernOutcome } from "../terns/index.js";
import type { AppDeps } from "./app-deps.js";
import { cancelledRecordOutcome } from "./live-runs.js";
import { executionEventAt } from "./run-events.js";
import { forgetTree } from "./tree-ends.js";
import { historyEndOf, keepExecutionRecord } from "./execution-history.js";
import type { TreeMoveParts, TreeState } from "./tree-move-types.js";
import { undoneTreeEnd, type EndedTreeUndo } from "./tree-unwind.js";

/**
 * Ending a tree without a pass, under its lease (#360's cancel request, `app.cancel` of a paused
 * tree, #340 PR 4's interrupted undo): its undo is marked under way and its record is `running`
 * while it runs (#340 S7 3: a crash mid-undo is found by the recovery sweep), its paused run dropped
 * (its pauses withdrawn, #337), its open undoable actions undone, then its record failed with the
 * final error — `CompensationFailedError` when an undo failed —, its keys and pauses forgotten and
 * `onExecutionError` observed once, only when this call failed the record.
 */

/** What ending a tree without a pass needs from its workflow's app. */
export type EndedTreeParts = Pick<TreeMoveParts, "deps" | "paused" | "trees" | "clock">;

/** How many of a thread's last records are looked at for its root's record. */
const RECORDS = 20;

/** The root's record among its thread's last ones; `undefined` when it is not there. */
export async function rootRecordOf(deps: AppDeps, state: TreeState): Promise<Tern | undefined> {
  const records = await deps.terns.lastTerns(state.tenantId, state.threadId, RECORDS);
  return records.find((record) => record.runId === state.runId);
}

/** The record's outcome for the tree's final error: a cancel, or what ended it. */
function endedOutcomeOf(record: Tern, error: Error): TernOutcome {
  const outcome = cancelledRecordOutcome(record.route, record.costUsd);
  return error instanceof ExecutionCancelledError
    ? outcome
    : { ...outcome, stopReason: error.message };
}

/** Fails a `running` or `paused` record; `true` when this call did (it is the one). */
async function failedRecord(deps: AppDeps, record: Tern, error: Error): Promise<boolean> {
  const outcome = endedOutcomeOf(record, error);
  return (
    (await deps.terns.completeIfStatus(record.id, ExecutionRecordStatus.Running, outcome)) ||
    (await deps.terns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, outcome))
  );
}

/** How a tree ended without a pass: its final error, and whether this call ended its record. */
export interface EndedTree {
  readonly error: Error;
  readonly isEnded: boolean;
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
  const { deps, paused } = parts;
  const record = await rootRecordOf(deps, state);
  const { markTreeUnwinding } = await import("./compensation/root-unwind.js");
  await markTreeUnwinding(deps, state, end.cause);
  if (record !== undefined) {
    const running = runningOutcome(record.route, record.costUsd);
    await deps.terns.completeIfStatus(record.id, ExecutionRecordStatus.Paused, running);
  }
  const stored = await paused.find(state);
  if (stored?.run.runId === state.runId) await paused.drop(state);
  const undo: EndedTreeUndo = end.undo ?? {};
  const failure = { error: end.cause, signal: end.signal, lease: end.lease };
  const ended = await undoneTreeEnd(deps, state, failure, undo);
  const error: Error = ended;
  const isEnded = record !== undefined && (await failedRecord(deps, record, error));
  await forgetTree(parts, state);
  // its undo ran here without a pass: the record lists what ran, as the event does (#484)
  const { compensations } = undo;
  if (isEnded) await keepExecutionRecord(deps, state, historyEndOf(error, compensations));
  if (isEnded) {
    const event = executionEventAt(state, deps);
    await deps.observer.onExecutionError({ ...event, error, compensations: compensations ?? [] });
  }
  return { error, isEnded };
}
