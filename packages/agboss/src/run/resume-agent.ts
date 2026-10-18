import { AGBossError } from "../core/errors.js";
import { Command } from "@langchain/langgraph";
import { ExecutionStatus } from "../app/types.js";
import type { ExecutionBudgetRecord } from "../budgets/execution-budgets.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import type { AgentLoopStateType } from "../graph/agent-loop/state.js";
import { continueRun, type ContinueOptions } from "./continue-run.js";
import { drainRun } from "./execute.js";
import { isWaiting, pausedLoopOf, runConfig } from "./paused.js";
import { readingGraphOf } from "./run-budgets.js";
import type { AgentExecutionOutput, RunDeps } from "./types.js";

/** `resume` of a run that is not waiting for a decision. */
export class NotPausedError extends AGBossError {
  static override readonly code: string = "run.not-paused";
  override name = "NotPausedError";
}

/** What a paused run is: its paused agent loop's state and the budgets it keeps. */
interface PausedRunState {
  readonly before: AgentLoopStateType;
  readonly budgets: readonly ExecutionBudgetRecord[] | undefined;
}

/** The paused agent loop's state of a run that is really waiting for an approval, and its budgets. */
async function pausedRun<TName extends string>(
  paused: AgentExecutionOutput,
  deps: RunDeps<TName>,
): Promise<PausedRunState> {
  const pause = deps.pause;
  if (paused.status !== ExecutionStatus.Paused || pause === undefined) {
    throw new NotPausedError(`Run ${paused.runId} was not paused or the pause seam is off`);
  }
  const graph = readingGraphOf(deps);
  const loop = (await isWaiting(graph, paused.runId))
    ? await pausedLoopOf(graph, pause.checkpointer, paused.runId)
    : undefined;
  if (loop === undefined) {
    throw new NotPausedError(`Run ${paused.runId} is not waiting for an approval`);
  }
  const snapshot = await graph.getState(runConfig(paused.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const { budgets } = snapshot.values as Partial<ExecutionStateType>;
  return { before: loop.state, budgets };
}

/**
 * Continues a paused run with the approver's decision — same run id, same Tern, same budget. Spend
 * recorded before the pause is not recorded again.
 */
export function resumeAgent<TName extends string>(
  paused: AgentExecutionOutput,
  decision: unknown,
  deps: RunDeps<TName>,
  options: ResumeOptions = {},
): Promise<AgentExecutionOutput> {
  return resumeOnce(paused, decision, deps, options);
}

type ResumeOptions = ContinueOptions;

async function resumeOnce<TName extends string>(
  paused: AgentExecutionOutput,
  decision: unknown,
  deps: RunDeps<TName>,
  options: ResumeOptions,
): Promise<AgentExecutionOutput> {
  const { before, budgets } = await pausedRun(paused, deps);
  // the same budgets — the amounts read at its start — their counters read anew
  const run = { ...paused, budgets, spent: before.usage };
  return continueRun(run, deps, options, async (moving, streaming, record) =>
    drainRun(
      await moving.stream(new Command({ resume: decision }), streaming),
      record,
      before.usage.length,
    ),
  );
}
