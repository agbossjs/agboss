import { AGBossError } from "../core/errors.js";
import { ExecutionStatus } from "../app/types.js";
import { CostReport, totalCost } from "../finops/usage.js";
import { maskedFinishLine } from "../flow/runtime/history.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import type { UsageRecord } from "../finops/usage.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { TurnOutcome } from "../turns/index.js";
import type { FinishContext } from "./execute.js";
import type { WaitingPause } from "../pause/index.js";
import { isWaiting, pausedLoopsOf, pausedUsageOf } from "./paused.js";
import { unrecordedOf } from "../finops/record-stream.js";
import { openPausesOf, waitingPausesOf } from "./waiting-pauses.js";
import type { AgentExecutionOutput, ExecutionData } from "./types.js";
import { traceUrlFieldOf } from "../tracing/trace-url.js";

/**
 * The Turn of an execution: a finished one's finish line (S8), a paused one waits. The line is
 * written masked by the observability policies (#1321d): once the tree's checkpoints are forgotten
 * it is all a late resume reads, and no raw PII stays in the store.
 */
export async function outcomeOf(
  state: ExecutionStateType,
  usage: readonly UsageRecord[],
  paused: boolean,
  mask?: ObservabilityMask,
): Promise<TurnOutcome> {
  const finished = !paused && state.finish !== "";
  return {
    replyWith: finished ? await maskedFinishLine(state.finish, state.output, mask) : "",
    status: paused ? "paused" : "answered",
    stopReason: paused ? "waiting for approval" : "",
    route: state.path,
    steps: [],
    costUsd: totalCost(usage),
  };
}

/** The finish and the output of a run that ended at a finish node: none for a paused one. */
export const endOf = (
  state: ExecutionStateType,
  paused: boolean,
): Pick<AgentExecutionOutput, "finish" | "output"> =>
  paused || state.finish === "" ? {} : { finish: state.finish, output: state.output };

/** The visited nodes; a paused execution waits in an agent whose visit has not finished yet. */
const pathOf = (state: ExecutionStateType, pending: readonly WaitingPause[]): readonly string[] => {
  const [first] = pending;
  return first === undefined ? state.path : [...state.path, first.step];
};

const traceUrlOf = <TName extends string>(ctx: FinishContext<TName>): { traceUrl?: string } =>
  traceUrlFieldOf(ctx.deps.tracing, {
    workflow: ctx.deps.config.name,
    threadId: ctx.base.threadId,
    runId: ctx.runId,
    tenantId: ctx.base.tenantId,
  });

/** Where the execution stopped: paused inside an agent's loop (its spend so far is there), or not. */
async function stoppedState<TName extends string>(
  ctx: FinishContext<TName>,
  state: ExecutionStateType,
): Promise<{
  readonly usage: readonly UsageRecord[];
  readonly paused: boolean;
  readonly pending: readonly WaitingPause[];
}> {
  const pause = ctx.deps.pause;
  if (pause === undefined || !(await isWaiting(ctx.graph, ctx.runId))) {
    return { usage: state.usage, paused: false, pending: [] };
  }
  const tree = { tenantId: ctx.base.tenantId, runId: ctx.runId };
  const pending = await waitingPausesOf(ctx.graph, pause.pauses, tree);
  const isOpen = await openPausesOf(pause.pauses, tree, { taken: ctx.takenPauseIds });
  const loops = await pausedLoopsOf(ctx.graph, pause.checkpointer, ctx.runId, isOpen);
  const usage = pausedUsageOf(state.usage, loops);
  // the paused loops' spend goes to the ledger now, not on resume — every loop's, once
  await ctx.record(unrecordedOf(usage, ctx.recorded));
  return { usage, paused: true, pending };
}

/** Where its request came from (#398 PR 2): a trusted mesh peer's, kept in its contexts. */
const originDataOf = (state: ExecutionStateType): Pick<ExecutionData, "origin"> => {
  const origin = state.contexts.mesh?.trusted?.origin;
  return origin === undefined ? {} : { origin };
};

/**
 * Every graph ends at a finish node, which sets `finish`: a graph that stopped without one and is
 * not waiting did not end (#1090) — it fails, never recorded as answered.
 */
function assertEnded(runId: string, state: ExecutionStateType, paused: boolean): void {
  if (paused || state.finish !== "") return;
  throw new AGBossError(
    `execution ${runId} stopped at no finish node and waits for nothing: its graph did not end — a framework bug; the run is failed, not recorded as answered`,
  );
}

/** The mask the finish line is written through: the workflow's observability, none without PII policies. */
const maskOf = <TName extends string>(ctx: FinishContext<TName>): ObservabilityMask | undefined =>
  ctx.deps.pii?.observability;

/** Writes (or completes) the Turn and shapes the result: finished or paused. */
export async function finishRun<TName extends string>(
  ctx: FinishContext<TName>,
  state: ExecutionStateType,
  existingTurnId?: string,
): Promise<AgentExecutionOutput> {
  const { usage, paused, pending } = await stoppedState(ctx, state);
  assertEnded(ctx.runId, state, paused);
  // a finish never lands over a durable stop or cancel mark (#1341b): the run ends as that
  const interrupted = paused ? undefined : await ctx.deps.compensation?.interrupted?.();
  if (interrupted !== undefined) throw interrupted;
  const outcome = await outcomeOf(state, usage, paused, maskOf(ctx));
  let turnId = existingTurnId;
  if (turnId === undefined) turnId = (await ctx.deps.turns.append({ ...ctx.base, ...outcome })).id;
  else await ctx.deps.turns.complete(turnId, outcome);
  return {
    status: paused ? ExecutionStatus.Paused : ExecutionStatus.Finished,
    start: state.start,
    startInput: state.startInput,
    path: pathOf(state, pending),
    budgetUsd: ctx.budgetUsd,
    cost: CostReport.fromUsage(usage),
    threadId: ctx.base.threadId,
    tenantId: ctx.base.tenantId,
    turnId,
    runId: ctx.runId,
    startedVersion: state.startedVersion === "" ? ctx.deps.config.version : state.startedVersion,
    data: {
      scope: state.scope,
      outdatedValues: state.outdatedValues,
      lastError: state.lastError,
      launches: state.launches,
      children: state.children,
      handledErrors: state.handledErrors,
      compensations: state.compensations,
      toolCalls: state.toolCalls,
      steps: state.stepRecords,
      ...originDataOf(state),
    },
    ...endOf(state, paused),
    pending,
    ...traceUrlOf(ctx),
    ...((ctx.compacted ?? []).length === 0 ? {} : { compacted: ctx.compacted }),
  };
}
