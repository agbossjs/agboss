import { randomUUID } from "node:crypto";
import type { UsageRecord } from "../finops/usage.js";
import { executionGraphOf } from "../flow/runtime/build.js";
import { startLine } from "../flow/runtime/history.js";
import { startNamed, validStartInput } from "../flow/runtime/start-input.js";
import { RunInputSchema } from "../input.js";
import {
  drainRun,
  failedOutcome,
  outcomeError,
  recordFailure,
  runningOutcome,
  type TernBase,
} from "./execute.js";
import { openExecutionBudgets, recorder, type PassBudgets } from "./run-budgets.js";
import { withMetadata } from "./run-services.js";
import { DEFAULT_CONTEXT_VALUES } from "../flow/context/context-values.js";
import { streamConfig } from "./stream-config.js";
import { finishRun } from "./finish.js";
import { openThread } from "./thread.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "./types.js";
import { runVersions } from "./versions.js";

/**
 * Public entry point: validates the input, opens or continues a thread, opens the execution's
 * budgets (each `maxSpend()` once; one exhausted → `BudgetExceededError` before any record or
 * call), runs the graph within its limits from the given start, records spend into the budgets as
 * it happens and writes a Tern for every outcome — finished, paused or failed.
 */
export function runAgent<TName extends string>(
  input: unknown,
  deps: RunDeps<TName>,
  options: RunOptions = {},
): Promise<AgentExecutionOutput> {
  return runOnce(input, deps, options);
}

/** `runAgent` with the budgets the app already opened (and checked) before the execution's start. */
export function runOpenedAgent<TName extends string>(
  input: unknown,
  deps: RunDeps<TName>,
  options: RunOptions,
  opened: PassBudgets,
): Promise<AgentExecutionOutput> {
  return runOnce(input, deps, options, opened);
}

/** What every Tern of the run has: its run, thread, start line, replay and versions. */
const ternBaseOf = <TName extends string>(
  deps: RunDeps<TName>,
  run: Pick<TernBase, "runId" | "threadId" | "tenantId" | "task">,
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
  opened?: PassBudgets,
): Promise<AgentExecutionOutput> {
  const { start, input: payload, threadId: requested } = RunInputSchema.parse(given);
  const input = validStartInput(startNamed(deps.graph, start), payload);
  const contexts = options.contexts ?? DEFAULT_CONTEXT_VALUES;
  const { tenantId } = contexts.tenant;
  const { threadId, history, summaries } = await openThread(deps, tenantId, requested);
  const spent: UsageRecord[] = [];
  const runId = options.runId ?? deps.newRunId?.() ?? randomUUID();
  const task = startLine(start, input);
  const base = ternBaseOf(deps, { runId, threadId, tenantId, task }, options);
  // before the first step: an exhausted budget rejects the execution — no record, no call
  const site = { executionId: runId, threadId, start, contexts };
  const budgets = opened ?? (await openExecutionBudgets(deps, { ...options, ...site }));
  let ternId: string | undefined;
  try {
    // the record is `running` while the tree moves: what recovery continues (#265 S30)
    ternId = (await deps.terns.append({ ...base, ...runningOutcome([], 0) })).id;
    const graph = executionGraphOf(deps, { budgets: budgets.meter });
    const identity = { threadId, tenantId, runId, input };
    const config = streamConfig(deps, identity, options);
    const record = recorder(budgets.meter, spent);
    const budgetUsd = budgets.meter.budgetUsd();
    const kept = { budgetUsd, budgets: budgets.records, history, summaries, runId };
    const initial = { start, startInput: input, contexts, ...kept };
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
  }
}
