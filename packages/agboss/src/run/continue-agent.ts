import { AGBossError } from "../core/errors.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { continueRun, type ContinueOptions } from "./continue-run.js";
import { drainRun, failedOutcome } from "./execute.js";
import { readingGraphOf } from "./run-budgets.js";
import { runConfig } from "./paused.js";
import type { AgentExecutionOutput, AgentExecutionDeps } from "./types.js";

/** The record of an interrupted execution recovery continues: its run, thread, tenant and record id. */
export interface InterruptedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly ternId: string;
  /** The workflow version it started on (its record's). */
  readonly startedVersion: string;
}

/**
 * An interrupted execution with nothing to continue from: it stopped before its first checkpoint
 * (its start input was never saved), so its record is completed as failed.
 */
export class NothingToRecoverError extends AGBossError {
  static override readonly code: string = "execution.nothing-to-recover";
  override name = "NothingToRecoverError";
}

/**
 * Continues an execution its instance left mid-step (#265 S30) from its last checkpoint: the
 * steps that finished keep their writes, only the interrupted one runs again — same run id, same
 * record, the same budgets. A tree whose graph had already finished (the instance
 * died before writing the record) is only finished.
 */
export async function continueAgent<TName extends string>(
  interrupted: InterruptedRun,
  deps: AgentExecutionDeps<TName>,
  options: ContinueOptions = {},
): Promise<AgentExecutionOutput> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(interrupted.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const before = snapshot.values as Partial<ExecutionStateType>;
  if (before.start === undefined || before.usage === undefined) {
    const error = new NothingToRecoverError(
      `execution ${interrupted.runId} stopped before its first checkpoint: nothing to continue`,
    );
    await deps.terns.complete(interrupted.ternId, failedOutcome(error, []));
    throw error;
  }
  const spent = before.usage;
  const run = {
    ...interrupted,
    start: before.start,
    startInput: before.startInput,
    budgetUsd: before.budgetUsd ?? 0,
    budgets: before.budgets,
    spent,
  };
  return continueRun(run, deps, options, async (moving, streaming, record) =>
    snapshot.next.length === 0
      ? (before as ExecutionStateType)
      : drainRun(await moving.stream(null, streaming), record, spent),
  );
}
