import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import type { RunContext } from "../../core/run-context.js";
import type { GraphDeps } from "../../graph/deps.js";
import { takeCarriedRecords } from "./carried-records.js";
import {
  CompensationFailedError,
  compensationRecordsOf,
  hasUndoableActions,
  type CompensationRecord,
} from "../compensation.js";
import type { Frame } from "../context/frame.js";
import type { ExecutionEvent } from "../observers/execution-event.js";
import type { ChildGraph } from "./child.js";
import {
  childFailureOf,
  childRecordOf,
  ownUsageOf,
  type ChildFailure,
  type EndedChild,
} from "./child-exit.js";
import type { ExecutionStateType } from "./state.js";
import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-lease-event.repository.js";

/**
 * A child execution that threw, as its parent's step sees it (#263 S25): undone first (#340 Q2,
 * `compensation/child-unwind.ts`, loaded only for a child whose workflow declares an undo), its
 * record and spend kept, its error event observed, its failure thrown — `CompensationFailedError`
 * as it is (S5).
 */

/**
 * Who announces a child's end (#562): the pass that ended it, never one that reads an end that came
 * before it. An `AnyInstance` child's finish is announced by the worker whose completion of its queue
 * row won (`app/remote/child-end-event.ts`), never by its parent. A child on its parent's instance is
 * announced by the parent's pass that ran it to its end — its finish, or a failure of its own — and a
 * remote child's failure by the parent's pass that waited for it (the undo runs there): a pass that
 * re-enters the step and finds the child already ended announces nothing. And only while that pass
 * still holds the tree's lease: a holder whose lease is no longer live — frozen past it, taken over —
 * stops at the announcement as at any step's write (a hand-over), announcing nothing.
 */
export function assertAnnouncing(frame: Frame): void {
  try {
    // its own fence (#533, its monotonic clock): no store round trip, no cancel check here
    frame.execution.lease?.assertHeld();
  } catch (error) {
    const handedOver = handedOverOf(error, frame.execution.signal);
    if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.Child, frame);
    throw error;
  }
}

/** The child's events: its own id, its parent and its root. */
export const eventOf = (frame: Frame, child: EndedChild): ExecutionEvent => ({
  executionId: child.identity.executionId,
  parentExecutionId: child.identity.parentExecutionId,
  rootExecutionId: child.identity.rootExecutionId,
  threadId: frame.execution.threadId,
  tenantId: frame.execution.tenant.tenantId,
  workflow: child.workflow,
});

/** A parent's side of one child execution: its deps, its step's frame, the child's undo (#340). */
export interface ChildParent {
  readonly deps: GraphDeps<string>;
  readonly frame: Frame;
  readonly undo: ChildUndo;
}

/** What the child's automatic undo needs besides its error (#340): the child's graph and run. */
export interface ChildUndo {
  readonly child: Pick<ChildGraph, "deps" | "workflow">;
  readonly run: RunContext;
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  readonly budgets?: BudgetMeter | undefined;
}

/**
 * A child that ended without a finish undoes its own open entries first (#340 Q2): the error its
 * parent gets — `CompensationFailedError` when an undo failed (S5) — and the entries it closed, kept
 * in the parent's state with the error. Loaded only for a child that can open one.
 */
async function undoneChild(
  parent: ChildParent,
  ended: EndedChild,
  thrown: unknown,
  run: {
    readonly last: ExecutionStateType | undefined;
    readonly config: RunnableConfig;
    readonly error: unknown;
  },
): Promise<{ readonly thrown: unknown; readonly compensations: readonly CompensationRecord[] }> {
  const { child } = parent.undo;
  const own = (run.last?.compensations ?? []).filter(
    (entry) => entry.executionId === ended.identity.executionId,
  );
  if (!hasUndoableActions(child.deps.graph))
    return { thrown, compensations: compensationRecordsOf(own) };
  const { unwoundChild } = await import("./compensation/child-unwind.js");
  const unwound = await unwoundChild(
    {
      ...{ deps: child.deps, workflow: child.workflow, run: parent.undo.run },
      executionId: ended.identity.executionId,
      parent: parent.frame,
      config: run.config,
      checkpointer: parent.undo.checkpointer,
      budgets: parent.undo.budgets,
      last: run.last?.compensations ?? [],
      error: run.error,
    },
    thrown,
  );
  parent.frame.services.keepCompensations?.(unwound.closed);
  return {
    thrown: unwound.thrown,
    compensations: compensationRecordsOf([...own, ...unwound.closed]),
  };
}

/** The child's spend for its parent: reported to its step, or — a failed undo, which no side path takes and which carries none — written to the ledger now. */
async function keptForParent(
  parent: ChildParent,
  failure: ChildFailure,
  raised: unknown,
): Promise<void> {
  for (const record of failure.reported) parent.frame.services.reportUsage?.(record);
  if (raised instanceof CompensationFailedError) await parent.undo.budgets?.record(failure.usage);
}

/** A child that threw: undone, its record and spend kept, its error event, its failure as the parent sees it. */
export async function failedChild(
  parent: ChildParent,
  ended: EndedChild,
  thrown: {
    readonly error: unknown;
    readonly last: ExecutionStateType | undefined;
    /** Whether this pass announces the failure (#562, `assertAnnouncing`, `child-failure.ts`). */
    readonly announces: boolean;
  },
  config: RunnableConfig,
): Promise<never> {
  const { frame } = parent;
  const { error, last } = thrown;
  const signal = config.signal ?? new AbortController().signal;
  const failure = childFailureOf(error, ended, ownUsageOf(last, ended.identity), signal);
  const undone = await undoneChild(parent, ended, failure.thrown, { last, config, error });
  const raised = undone.thrown;
  await keptForParent(parent, failure, raised);
  // the failed visit's calls and step, carried by the child's own error (#395 S6), are the child's
  const carried = takeCarriedRecords(error);
  frame.services.recordChild?.(childRecordOf(ended, last, { ...failure, error: raised, carried }));
  // what the child masked stays revealable by the parent's side path (#120)
  if (last !== undefined) frame.services.keepPiiTokens?.(last.piiTokens);
  if (!thrown.announces) throw raised;
  assertAnnouncing(frame);
  const asError = raised instanceof Error ? raised : new Error(String(error));
  const { compensations } = undone;
  await parent.deps.observer?.onExecutionError({
    ...eventOf(frame, ended),
    error: asError,
    compensations,
  });
  throw raised;
}
