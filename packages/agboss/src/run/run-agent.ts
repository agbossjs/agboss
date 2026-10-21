import { randomIdGenerator } from "../infrastructure/clock.js";
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
import { DEFAULT_CONTEXT_VALUES } from "../flow/context/context-values.js";
import { streamConfig } from "./stream-config.js";
import { finishRun } from "./finish.js";
import { openThread } from "./thread.js";
import { memoryBeforeRun } from "./memory.js";
import type { AgentExecutionOutput, AgentExecutionDeps, AgentExecutionOptions } from "./types.js";
import { executionVersions } from "./versions.js";
import { newPiiKey } from "../pii/tokens.js";

/**
 * Public entry point: validates the input, opens or continues a thread, opens the execution's
 * budgets (each `maxSpend()` once; one exhausted → `BudgetExceededError` before any record or
 * call), runs the graph within its limits from the given start, records spend into the budgets as
 * it happens and writes a Tern for every outcome — finished, paused or failed.
 */
export function executeAgent<TName extends string>(
  input: unknown,
  deps: AgentExecutionDeps<TName>,
  options: AgentExecutionOptions = {},
): Promise<AgentExecutionOutput> {
  return runOnce(input, deps, options);
}

/** `executeAgent` with the budgets the app already opened (and checked) before the execution's start. */
export function runOpenedAgent<TName extends string>(
  input: unknown,
  deps: AgentExecutionDeps<TName>,
  options: AgentExecutionOptions,
  opened: PassBudgets,
): Promise<AgentExecutionOutput> {
  return runOnce(input, deps, options, opened);
}

/** What every Tern of the run has: its run, thread, start line, replay and versions. */
const ternBaseOf = <TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: Pick<TernBase, "runId" | "threadId" | "tenantId" | "task">,
  options: AgentExecutionOptions,
): TernBase => ({
  ...run,
  bundle: deps.config.name,
  replayOf: options.replayOf ?? null,
  ...executionVersions(deps),
});

async function runOnce<TName extends string>(
  given: unknown,
  deps: AgentExecutionDeps<TName>,
  options: AgentExecutionOptions,
  opened?: PassBudgets,
): Promise<AgentExecutionOutput> {
  const { start, input: payload, threadId: requested } = RunInputSchema.parse(given);
  const input = validStartInput(startNamed(deps.graph, start), payload);
  const contexts = options.contexts ?? DEFAULT_CONTEXT_VALUES;
  const { tenantId } = contexts.tenant;
  const runId = options.executionId ?? (deps.idGenerator ?? randomIdGenerator).newExecutionId();
  // a thread it continues must exist; a new one is created only once the budgets pass
  const known = requested === undefined ? undefined : await openThread(deps, tenantId, requested);
  // before the first step: an exhausted budget rejects the execution — no thread, record or call
  const site = { executionId: runId, threadId: requested, start, contexts };
  const budgets = opened ?? (await openExecutionBudgets(deps, { ...options, ...site }));
  const { threadId } = known ?? (await openThread(deps, tenantId, undefined));
  const spent: UsageRecord[] = [];
  const base = ternBaseOf(
    deps,
    { runId, threadId, tenantId, task: startLine(start, input) },
    options,
  );
  let ternId: string | undefined;
  try {
    const config = streamConfig(deps, { threadId, tenantId, runId, input }, options);
    const record = recorder(budgets.meter, spent);
    const budgetUsd = budgets.meter.budgetUsd();
    const thread = { tenantId, threadId, isNewThread: known === undefined, record };
    const before = { ...thread, budgetLeftUsd: budgetUsd, callbacks: config.callbacks };
    // the compactions due run before the thread is read: a CompactionError fails it here (S132)
    const read = await memoryBeforeRun(deps, before);
    // the record is `running` while the tree moves: what recovery continues (#265 S30)
    ternId = (await deps.terns.append({ ...base, ...runningOutcome([], 0) })).id;
    const graph = executionGraphOf(deps, { budgets: budgets.meter });
    const memory = { history: read.history, memory: read.memory, usage: [...read.usage] };
    const kept = { budgetUsd, budgets: budgets.records, ...memory, runId };
    // no application key: the execution's own, kept in its checkpoint for every instance (#334)
    const piiKey = deps.pii?.isInstanceKey === true ? newPiiKey() : null;
    const initial = { start, startInput: input, contexts, piiKey, ...kept };
    const state = await drainRun(await graph.stream(initial, config), record, read.usage);
    const context = { deps, graph, base, runId, budgetUsd, record, recorded: spent };
    const finish = { ...context, callbacks: config.callbacks, compacted: read.compacted };
    return await finishRun(finish, state, ternId);
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
