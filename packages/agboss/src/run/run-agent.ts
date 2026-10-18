import { randomUUID } from "node:crypto";
import type { UsageRecord } from "../finops/usage.js";
import { executionGraphOf } from "../flow/runtime/build.js";
import { startLine } from "../flow/runtime/history.js";
import { startNamed, validStartInput } from "../flow/runtime/start-input.js";
import { RunInputSchema } from "../input.js";
import {
  allowedBudget,
  drainRun,
  failedOutcome,
  outcomeError,
  recordFailure,
  recorder,
  runningOutcome,
  workflowAccount,
  type TernBase,
} from "./execute.js";
import { withMetadata } from "./run-services.js";
import { streamConfig } from "./stream-config.js";
import { finishRun } from "./finish.js";
import { openThread } from "./thread.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "./types.js";
import { runVersions } from "./versions.js";

/**
 * Public entry point: validates the input, opens or continues a thread, checks the daily cap
 * (nothing left → no calls), runs the graph within the workflow's limits from the given start,
 * records spend as it happens and writes a Tern for every outcome — finished, paused or failed.
 */
export function runAgent<TName extends string>(
  input: unknown,
  deps: RunDeps<TName>,
  options: RunOptions = {},
): Promise<AgentExecutionOutput> {
  return runOnce(input, deps, options);
}

/** What every Tern of the run has: its run, thread, start line, replay and versions. */
const ternBaseOf = <TName extends string>(
  deps: RunDeps<TName>,
  run: Pick<TernBase, "runId" | "threadId" | "task">,
  options: RunOptions,
): TernBase => ({
  ...run,
  bundle: deps.config.name,
  replayOf: options.replayOf ?? null,
  ...runVersions(deps),
});

async function runOnce<TName extends string>(
  given: unknown,
  deps: RunDeps<TName>,
  options: RunOptions,
): Promise<AgentExecutionOutput> {
  const { start, input: payload, threadId: requested } = RunInputSchema.parse(given);
  const input = validStartInput(startNamed(deps.graph, start), payload);
  const account = options.account ?? workflowAccount(deps);
  const { threadId, history, summaries } = await openThread(deps, requested);
  const spent: UsageRecord[] = [];
  const runId = options.runId ?? deps.newRunId?.() ?? randomUUID();
  const base = ternBaseOf(deps, { runId, threadId, task: startLine(start, input) }, options);
  let release = (): void => undefined;
  let ternId: string | undefined;
  try {
    const { budgetUsd, run, hold } = await allowedBudget(deps, account);
    release = hold.release;
    // the record is `running` while the tree moves: what recovery continues (#265 S30)
    ternId = (await deps.terns.append({ ...base, ...runningOutcome([], 0) })).id;
    const graph = executionGraphOf(deps, run);
    const identity = { threadId, runId, input };
    const config = streamConfig(deps, identity, options);
    const record = recorder(hold, spent);
    const initial = { start, startInput: input, budgetUsd, history, summaries, runId };
    const state = await drainRun(await graph.stream(initial, config), record);
    const recorded = state.usage.length;
    const context = { deps, graph, base, runId, budgetUsd, record, recorded };
    const output = await finishRun({ ...context, callbacks: config.callbacks }, state, ternId);
    return withMetadata(output, options.metadata);
  } catch (error) {
    const cause = outcomeError(error, options.signal);
    const failed = failedOutcome(cause, spent);
    throw await recordFailure(cause, () =>
      ternId === undefined
        ? deps.terns.append({ ...base, ...failed })
        : deps.terns.complete(ternId, failed),
    );
  } finally {
    // ended or paused: what the run did not spend goes back to the day (a resume reserves anew)
    release();
  }
}
