import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import type { RunContext } from "../../core/run-context.js";
import type { GraphDeps } from "../../graph/deps.js";
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

/**
 * A child execution that threw, as its parent's step sees it (#263 S25): undone first (#340 Q2,
 * `compensation/child-unwind.ts`, loaded only for a child whose workflow declares an undo), its
 * record and spend kept, its error event observed, its failure thrown — `CompensationFailedError`
 * as it is (S5).
 */

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
  thrown: { readonly error: unknown; readonly last: ExecutionStateType | undefined },
  config: RunnableConfig,
): Promise<never> {
  const { frame } = parent;
  const { error, last } = thrown;
  const signal = config.signal ?? new AbortController().signal;
  const failure = childFailureOf(error, ended, ownUsageOf(last, ended.identity), signal);
  const undone = await undoneChild(parent, ended, failure.thrown, { last, config, error });
  const raised = undone.thrown;
  await keptForParent(parent, failure, raised);
  frame.services.recordChild?.(childRecordOf(ended, last, { ...failure, error: raised }));
  // what the child masked stays revealable by the parent's side path (#120)
  if (last !== undefined) frame.services.keepPiiTokens?.(last.piiTokens);
  const asError = raised instanceof Error ? raised : new Error(String(error));
  const { compensations } = undone;
  await parent.deps.observer?.onExecutionError({
    ...eventOf(frame, ended),
    error: asError,
    compensations,
  });
  throw raised;
}
