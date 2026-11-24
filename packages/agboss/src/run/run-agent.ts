import { usd } from "../units/index.js";
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
  type TurnBase,
} from "./execute.js";
import { inStartFrame, openExecutionBudgets, recorder, type PassBudgets } from "./run-budgets.js";
import { DEFAULT_CONTEXT_VALUES } from "../flow/context/context-values.js";
import { streamConfig } from "./stream-config.js";
import { finishRun } from "./finish.js";
import { openThread } from "./thread.js";
import { memoryBeforeRun } from "./compact-before-run.js";
import type { AgentExecutionOutput, AgentExecutionDeps, AgentExecutionOptions } from "./types.js";
import { executionVersions } from "./versions.js";
import { newPiiKey } from "../pii/tokens.js";

/**
 * Public entry point: validates the input, opens or continues a thread, opens the execution's
 * budgets (each `maxSpend()` once; one exhausted → `BudgetExceededError` before any record or
 * call), runs the graph within its limits from the given start, records spend into the budgets as
 * it happens and writes a Turn for every outcome — finished, paused or failed.
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

/** What every Turn of the run has: its run, thread, start line, replay and versions. */
const turnBaseOf = <TName extends string>(
  deps: AgentExecutionDeps<TName>,
  run: Pick<TurnBase, "runId" | "threadId" | "tenantId" | "task">,
  options: AgentExecutionOptions,
): TurnBase => ({
  ...run,
  workflow: deps.config.name,
  replayOf: options.replayOf ?? null,
  ...executionVersions(deps),
});

/** When a root execution starts (#401: its history's start), on the application's clock. */
const startedAtOf = <TName extends string>(deps: AgentExecutionDeps<TName>): string =>
  (deps.clock ?? systemClock).now().toISOString();

/** A thread with turns reused by a workflow without memory: its agents read none of them (#1303b, D8). */
async function warnIfStateless<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  subject: { readonly executionId: string; readonly tenantId: string; readonly threadId: string },
): Promise<void> {
  if (deps.memories === undefined || deps.memories.memories.length > 0) return;
  const { threadId, ...logged } = subject;
  if ((await deps.turns.lastTurns(subject.tenantId, threadId, 1)).length === 0) return;
  deps.log?.warn(
    "memory.thread-reuse-without-memory",
    `${deps.config.name} has no memory: this execution reuses a thread with turns, but no agent reads its earlier turns — set memory on the workflow or an agent`,
    logged,
  );
}

/** The thread a request names, which must exist; a workflow without memory is warned about reusing it. */
async function knownThreadOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly requested: string | undefined;
  },
): Promise<{ readonly threadId: string } | undefined> {
  const { tenantId, runId, requested } = request;
  if (requested === undefined) return undefined;
  const known = await openThread(deps, tenantId, requested);
  await warnIfStateless(deps, { executionId: runId, tenantId, threadId: known.threadId });
  return known;
}

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
  const known = await knownThreadOf(deps, { tenantId, runId, requested });
  // before the first step: an exhausted budget rejects the execution — no thread, record or call
  const site = { executionId: runId, threadId: requested, start, contexts };
  const budgets = opened ?? (await openExecutionBudgets(deps, { ...options, ...site }));
  const { threadId } = known ?? (await openThread(deps, tenantId, undefined));
  const spent: UsageRecord[] = [];
  const base = turnBaseOf(
    deps,
    { runId, threadId, tenantId, task: startLine(start, input) },
    options,
  );
  let turnId: string | undefined;
  try {
    const config = streamConfig(deps, { threadId, tenantId, runId, input }, options);
    const record = recorder(budgets.meter, spent);
    const budgetUsd = budgets.meter.budgetUsd();
    const thread = { tenantId, threadId, isNewThread: known === undefined, record };
    const inFrame = inStartFrame(deps, { ...options, ...site, threadId });
    const before = { ...thread, budgetUsd, callbacks: config.callbacks, inFrame };
    // the compactions due run before the thread is read: a CompactionError fails it here (S132)
    const read = await memoryBeforeRun(deps, before);
    // the record is `running` while the tree moves: what recovery continues (#265 S30)
    turnId = (await deps.turns.append({ ...base, ...runningOutcome([], usd(0)) })).id;
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
    return await finishRun(finish, state, turnId);
  } catch (error) {
    throw await failureRecorded(deps, base, outcomeError(error, options.signal), {
      turnId,
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
  base: TurnBase,
  cause: unknown,
  run: { readonly turnId: string | undefined; readonly spent: readonly UsageRecord[] },
): Promise<unknown> {
  const { turnId, spent } = run;
  const unwind = turnId === undefined ? undefined : deps.compensation?.rootUnwind;
  return recordFailure(
    cause,
    (ended) =>
      turnId === undefined
        ? deps.turns.append({ ...base, ...failedOutcome(ended, spent) })
        : deps.turns.complete(turnId, failedOutcome(ended, spent)),
    unwind,
  );
}
