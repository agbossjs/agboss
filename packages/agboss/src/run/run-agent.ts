import { systemClock, unkeptExecutionIds } from "../infrastructure/clock.js";
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
import { inStartFrame, openExecutionBudgets, recorder, type PassBudgets } from "./run-budgets.js";
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

/** When a root execution starts (#401: its history's start), on the application's clock. */
const startedAtOf = <TName extends string>(deps: AgentExecutionDeps<TName>): string =>
  (deps.clock ?? systemClock).now().toISOString();

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
  // a run of its own (a replay, a comparison) keeps its new id first, as `execute` does (#591)
  const runId =
    options.executionId ??
    (await (deps.executionIds ?? unkeptExecutionIds).newExecutionId(tenantId));
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
    const inFrame = inStartFrame(deps, { ...options, ...site, threadId });
    const before = { ...thread, budgetLeftUsd: budgetUsd, callbacks: config.callbacks, inFrame };
    // the compactions due run before the thread is read: a CompactionError fails it here (S132)
    const read = await memoryBeforeRun(deps, before);
    // the record is `running` while the tree moves: what recovery continues (#265 S30)
    ternId = (await deps.terns.append({ ...base, ...runningOutcome([], 0) })).id;
    const graph = executionGraphOf(deps, { budgets: budgets.meter });
    const memory = { history: read.history, memory: read.memory, usage: [...read.usage] };
    const kept = { budgetUsd, budgets: budgets.records, ...memory, runId };
    // no application key: the execution's own, kept in its checkpoint for every instance (#334)
    const piiKey = deps.pii?.isInstanceKey === true ? newPiiKey() : null;
    const startedAt = startedAtOf(deps);
    const initial = { start, startInput: input, contexts, piiKey, startedAt, ...kept };
    const state = await drainRun(await graph.stream(initial, config), record, read.usage);
    const context = { deps, graph, base, runId, budgetUsd, record, recorded: spent };
    const finish = { ...context, callbacks: config.callbacks, compacted: read.compacted };
    return await finishRun(finish, state, ternId);
  } catch (error) {
    throw await failureRecorded(deps, base, outcomeError(error, options.signal), {
      ternId,
      spent,
    });
  }
}

/**
 * Records a failed run — appended, or its `running` record completed — and returns the error to
 * throw; a tree's record is failed once its undo ended (#340 S7 3), none before its record existed.
 */
function failureRecorded<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  base: TernBase,
  cause: unknown,
  run: { readonly ternId: string | undefined; readonly spent: readonly UsageRecord[] },
): Promise<unknown> {
  const { ternId, spent } = run;
  const unwind = ternId === undefined ? undefined : deps.compensation?.rootUnwind;
  return recordFailure(
    cause,
    (ended) =>
      ternId === undefined
        ? deps.terns.append({ ...base, ...failedOutcome(ended, spent) })
        : deps.terns.complete(ternId, failedOutcome(ended, spent)),
    unwind,
  );
}
