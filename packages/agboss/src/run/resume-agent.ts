import { AGBossError } from "../core/errors.js";
import { Command } from "@langchain/langgraph";
import { reserveSpend } from "../finops/reservations.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import { ExecutionStatus } from "../app/types.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import { startLine } from "../flow/runtime/history.js";
import type { AgentLoopStateType } from "../graph/agent-loop/state.js";
import {
  drainRun,
  failedOutcome,
  outcomeError,
  recordFailure,
  recorder,
  workflowAccount,
} from "./execute.js";
import { withMetadata } from "./run-services.js";
import { streamConfig } from "./stream-config.js";
import { finishRun } from "./finish.js";
import { isWaiting, pausedLoopOf } from "./paused.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "./types.js";
import { runVersions } from "./versions.js";

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

type ResumeOptions = Omit<RunOptions, "replayOf" | "account" | "runId">;

async function resumeOnce<TName extends string>(
  paused: AgentExecutionOutput,
  decision: unknown,
  deps: RunDeps<TName>,
  options: ResumeOptions,
): Promise<AgentExecutionOutput> {
  const { graph, before } = await pausedRun(paused, deps);
  const metadata = options.metadata ?? paused.metadata;
  const spent: UsageRecord[] = [];
  // the pause released the run's hold: the rest of its budget is held again while it continues
  const left = paused.budgetUsd - totalCost(before.usage);
  const hold = await reserveSpend(deps.ledger, workflowAccount(deps), Math.max(0, left));
  const record = recorder(hold, spent);
  const base = {
    runId: paused.runId,
    threadId: paused.threadId,
    bundle: deps.config.name,
    task: startLine(paused.start, paused.startInput),
    replayOf: null,
    ...runVersions(deps),
  };
  try {
    const streaming = streamConfig(
      deps,
      { threadId: paused.threadId, runId: paused.runId, input: paused.startInput },
      { ...options, metadata },
    );
    const states = await graph.stream(new Command({ resume: decision }), streaming);
    const state = await drainRun(states, record, before.usage.length);
    const context = {
      deps,
      graph,
      base,
      runId: paused.runId,
      budgetUsd: paused.budgetUsd,
      record,
      recorded: Math.max(before.usage.length, state.usage.length),
      callbacks: streaming.callbacks,
    };
    const output = await finishRun(context, state, paused.ternId);
    return withMetadata(output, metadata);
  } catch (error) {
    const cause = outcomeError(error, options.signal);
    throw await recordFailure(cause, () =>
      deps.terns.complete(paused.ternId, failedOutcome(cause, [...before.usage, ...spent])),
    );
  } finally {
    hold.release();
  }
}
