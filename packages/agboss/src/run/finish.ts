import { ExecutionStatus } from "../app/types.js";
import { buildCostReport, totalCost } from "../finops/usage.js";
import { finishLine } from "../flow/runtime/history.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import type { UsageRecord } from "../finops/usage.js";
import type { TernOutcome } from "../terns/index.js";
import { updateMemoryAfter } from "./memory.js";
import type { FinishContext } from "./execute.js";
import type { PendingPause } from "../pause/index.js";
import { isWaiting, pausedLoopOf } from "./paused.js";
import type { AgentExecutionOutput, RunDeps } from "./types.js";

/** The Tern of an execution: a finished one's finish line (S8), a paused one waits. */
function outcomeOf(
  state: ExecutionStateType,
  usage: readonly UsageRecord[],
  paused: boolean,
): TernOutcome {
  const finished = !paused && state.finish !== "";
  return {
    replyWith: finished ? finishLine(state.finish, state.output) : "",
    status: paused ? "paused" : "answered",
    stopReason: paused ? "waiting for approval" : "",
    route: state.path,
    steps: [],
    costUsd: totalCost(usage),
  };
}

/** The visited nodes; a paused execution waits in an agent whose visit has not finished yet. */
const pathOf = (state: ExecutionStateType, pending: PendingPause | undefined): readonly string[] =>
  pending === undefined ? state.path : [...state.path, pending.agent];

const traceUrlOf = <TName extends string>(
  deps: RunDeps<TName>,
  threadId: string,
): { traceUrl?: string } => {
  const traceUrl = deps.tracing?.sessionUrl(threadId);
  return traceUrl === undefined ? {} : { traceUrl };
};

/** Where the execution stopped: paused inside an agent's loop (its spend so far is there), or not. */
async function stoppedState<TName extends string>(
  ctx: FinishContext<TName>,
  state: ExecutionStateType,
): Promise<{
  readonly usage: readonly UsageRecord[];
  readonly paused: boolean;
  readonly pending?: PendingPause;
}> {
  const pause = ctx.deps.pause;
  if (pause === undefined || !(await isWaiting(ctx.graph, ctx.runId))) {
    return { usage: state.usage, paused: false };
  }
  const loop = await pausedLoopOf(ctx.graph, pause.checkpointer, ctx.runId);
  if (loop === undefined) return { usage: state.usage, paused: true };
  // the paused loop's spend goes to the ledger now, not on resume
  await ctx.record(loop.state.usage.slice(Math.max(ctx.recorded, state.usage.length)));
  return { usage: loop.state.usage, paused: true, pending: loop.pending };
}

/** Writes (or completes) the Tern and shapes the result: finished or paused. */
export async function finishRun<TName extends string>(
  ctx: FinishContext<TName>,
  state: ExecutionStateType,
  existingTernId?: string,
): Promise<AgentExecutionOutput> {
  const { usage, paused, pending } = await stoppedState(ctx, state);
  const outcome = outcomeOf(state, usage, paused);
  let ternId = existingTernId;
  if (ternId === undefined) ternId = (await ctx.deps.terns.append({ ...ctx.base, ...outcome })).id;
  else await ctx.deps.terns.complete(ternId, outcome);
  const memory = paused
    ? { usage: [] }
    : await updateMemoryAfter(ctx, usage, { start: ctx.base.task, finish: outcome.replyWith });
  return {
    status: paused ? ExecutionStatus.Paused : ExecutionStatus.Finished,
    start: state.start,
    startInput: state.startInput,
    path: pathOf(state, pending),
    budgetUsd: ctx.budgetUsd,
    cost: buildCostReport([...usage, ...memory.usage]),
    threadId: ctx.base.threadId,
    tenantId: ctx.base.tenantId,
    ternId,
    runId: ctx.runId,
    startedVersion: state.startedVersion === "" ? ctx.deps.config.version : state.startedVersion,
    data: {
      scope: state.scope,
      outdatedValues: state.outdatedValues,
      lastError: state.lastError,
      launches: state.launches,
    },
    ...(paused || state.finish === "" ? {} : { finish: state.finish, output: state.output }),
    ...(pending === undefined ? {} : { pending }),
    ...traceUrlOf(ctx.deps, ctx.base.threadId),
    ...(memory.compacted === undefined ? {} : { compacted: memory.compacted }),
  };
}
