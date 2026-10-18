import { AGBossError } from "../core/errors.js";
import { Command } from "@langchain/langgraph";
import { ExecutionStatus } from "../app/types.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import type { AgentLoopStateType } from "../graph/agent-loop/state.js";
import { continueRun, type ContinueOptions } from "./continue-run.js";
import { drainRun, workflowAccount } from "./execute.js";
import { isWaiting, pausedLoopOf } from "./paused.js";
import type { AgentExecutionOutput, RunDeps } from "./types.js";

/** `resume` of a run that is not waiting for a decision. */
export class NotPausedError extends AGBossError {
  static override readonly code: string = "run.not-paused";
  override name = "NotPausedError";
}

/** The graph and the paused agent loop's state of a run that is really waiting for an approval. */
async function pausedRun<TName extends string>(
  paused: AgentExecutionOutput,
  deps: RunDeps<TName>,
): Promise<{ graph: ExecutionGraph; before: AgentLoopStateType }> {
  const pause = deps.pause;
  if (paused.status !== ExecutionStatus.Paused || pause === undefined) {
    throw new NotPausedError(`Run ${paused.runId} was not paused or the pause seam is off`);
  }
  const account = workflowAccount(deps);
  const graph = executionGraphOf(deps, {
    limits: deps.limits,
    spentToday: () => deps.ledger.spentToday(account.key),
  });
  const loop = (await isWaiting(graph, paused.runId))
    ? await pausedLoopOf(graph, pause.checkpointer, paused.runId)
    : undefined;
  if (loop === undefined) {
    throw new NotPausedError(`Run ${paused.runId} is not waiting for an approval`);
  }
  return { graph, before: loop.state };
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
  const { graph, before } = await pausedRun(paused, deps);
  // the pause released the run's hold: the rest of its budget is held again while it continues
  const run = { ...paused, spent: before.usage };
  return continueRun(graph, run, deps, options, async (moving, streaming, record) =>
    drainRun(
      await moving.stream(new Command({ resume: decision }), streaming),
      record,
      before.usage.length,
    ),
  );
}
