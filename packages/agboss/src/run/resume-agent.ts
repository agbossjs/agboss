import { AGBossError } from "../core/errors.js";
import { Command } from "@langchain/langgraph";
import { ExecutionStatus } from "../app/types.js";
import type { ExecutionBudgetRecord } from "../budgets/execution-budgets.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { continueRun, type ContinueOptions } from "./continue-run.js";
import { drainRun } from "./execute.js";
import { isWaiting, pausedLoopsOf, pausedUsageOf, runConfig } from "./paused.js";
import { openPausesOf } from "./waiting-pauses.js";
import type { UsageRecord } from "../finops/usage.js";
import { readingGraphOf } from "./run-budgets.js";
import type { TreeResume } from "./resume-map.js";
import type { AgentExecutionOutput, RunDeps } from "./types.js";

/** `resume` of a run that is not waiting for a decision. */
export class NotPausedError extends AGBossError {
  static override readonly code: string = "run.not-paused";
  override name = "NotPausedError";
}

/** What a paused run is: what it spent so far (every paused loop's), and the budgets it keeps. */
interface PausedRunState {
  readonly spent: readonly UsageRecord[];
  readonly budgets: readonly ExecutionBudgetRecord[] | undefined;
}

/** What a run that is really waiting for an approval spent so far, and its budgets. */
async function pausedRun<TName extends string>(
  paused: AgentExecutionOutput,
  resume: TreeResume,
  deps: RunDeps<TName>,
): Promise<PausedRunState> {
  const pause = deps.pause;
  if (paused.status !== ExecutionStatus.Paused || pause === undefined) {
    throw new NotPausedError(`Run ${paused.runId} was not paused or the pause seam is off`);
  }
  const graph = readingGraphOf(deps);
  const loops = (await isWaiting(graph, paused.runId))
    ? await pausedLoopsOf(
        graph,
        pause.checkpointer,
        paused.runId,
        await openPausesOf(
          pause.pauses,
          { tenantId: paused.tenantId, runId: paused.runId },
          { answering: new Set(resume.pauseIds) },
        ),
      )
    : [];
  if (loops.length === 0) {
    throw new NotPausedError(`Run ${paused.runId} is not waiting for an approval`);
  }
  const snapshot = await graph.getState(runConfig(paused.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const { budgets, usage } = snapshot.values as Partial<ExecutionStateType>;
  // reading a free-text reply (#267 PR 3) is in the ledger already: its step adds it to the spend
  const replies = resume.taken.flatMap((pause) => pause.answer?.usage ?? []);
  return { spent: [...pausedUsageOf(usage ?? [], loops), ...replies], budgets };
}

/**
 * Continues a paused run with the answers its pauses have (`TreeResume`, #267 S35) — same run id,
 * same Tern, same budget. Spend recorded before the pause is not recorded again.
 */
export async function resumeAgent<TName extends string>(
  paused: AgentExecutionOutput,
  resume: TreeResume,
  deps: RunDeps<TName>,
  options: ContinueOptions = {},
): Promise<AgentExecutionOutput> {
  const { spent, budgets } = await pausedRun(paused, resume, deps);
  // the same budgets — the amounts read at its start — their counters read anew
  const takenPauseIds = new Set(resume.taken.map((pause) => pause.pauseId));
  const run = { ...paused, budgets, spent, takenPauseIds };
  return continueRun(run, deps, options, async (moving, streaming, record) =>
    drainRun(await moving.stream(new Command({ resume: resume.values }), streaming), record, spent),
  );
}
