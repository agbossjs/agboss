import { ExecutionCancelledError } from "../core/errors.js";
import { handedOverOf, isHandedOver } from "../app/handed-over.js";
import { drainRecordingUsage } from "../finops/record-stream.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { PaidStepError } from "../graph/errors.js";
import { LimitExceededError } from "../graph/limits.js";
import type { NewTern, TernOutcome } from "../terns/index.js";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AgentExecutionDeps } from "./types.js";
import type { Compacted } from "./compaction.js";
import type { RootUnwind } from "../flow/runtime/compensation/registry.js";

export type TernBase = Pick<
  NewTern,
  | "runId"
  | "threadId"
  | "tenantId"
  | "bundle"
  | "task"
  | "replayOf"
  | "promptVersion"
  | "modelVersion"
  | "configVersion"
  | "configHash"
>;

/** What finishing a run needs: its deps, graph, Tern base, id, budget and spend so far. */
export interface FinishContext<TName extends string> {
  readonly deps: AgentExecutionDeps<TName>;
  readonly graph: ExecutionGraph;
  readonly base: TernBase;
  readonly runId: string;
  readonly budgetUsd: number;
  /** Where spend goes as it happens: the Tern's list and the budgets' counters. */
  readonly record: (records: readonly UsageRecord[]) => Promise<void>;
  /** The run's usage records already in the ledger (this pass's and the passes before). */
  readonly recorded: readonly UsageRecord[];
  /** The resolved pauses this pass answered: their loops went on, they no longer wait. */
  readonly takenPauseIds?: ReadonlySet<string> | undefined;
  readonly callbacks: BaseCallbackHandler[];
  /** What the compactions did before this execution read its thread (#120 S132). */
  readonly compacted?: readonly Compacted[] | undefined;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A run stopped by its signal reads as cancelled, whatever error the abort surfaced as — or, when
 * its instance lost the tree's lease or stopped, as `ExecutionLeaseLostError` /
 * `ApplicationStoppingError` (not a failure, #265).
 */
export const outcomeError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  // a fenced write behind the error first (#471): the moving call rejects with it, as it is
  const handedOver = handedOverOf(error, signal);
  if (handedOver !== undefined) return handedOver;
  return signal?.aborted === true && !(error instanceof ExecutionCancelledError)
    ? new ExecutionCancelledError("the run was cancelled")
    : error;
};

/**
 * Writes the failed record of a run that failed (#265: a lost lease or an interruption writes
 * nothing — the record stays `running`, another instance owns it) and returns the error to throw.
 * A tree's pass first undoes the root (#340 S7 3, `unwind`): the record stays `running` until the
 * undo ended, then gets its final error (`CompensationFailedError` when an undo failed); an undo
 * handed over meanwhile writes nothing.
 */
export async function recordFailure(
  error: unknown,
  write: (ended: unknown) => Promise<unknown>,
  unwind?: RootUnwind,
): Promise<unknown> {
  if (isHandedOver(error)) return error;
  const ended = unwind === undefined ? error : await unwind(error);
  await write(ended);
  return ended;
}

/**
 * The record of an execution while its tree moves (#265 S30): `running`, what it visited and spent
 * so far — what recovery continues when its instance dies.
 */
export const runningOutcome = (route: readonly string[], costUsd: number): TernOutcome => ({
  replyWith: "",
  status: "running",
  stopReason: "",
  route,
  steps: [],
  costUsd,
});

export const failedOutcome = (error: unknown, spent: readonly UsageRecord[]): TernOutcome => ({
  replyWith: "",
  status: "failed",
  stopReason: errorMessage(error),
  route: [],
  steps: [],
  costUsd: totalCost(spent),
});

/** LangGraph emits `{ __interrupt__ }` chunks when a run pauses; only real states carry usage. */
async function* statesOnly(
  chunks: AsyncIterable<ExecutionStateType>,
): AsyncGenerator<ExecutionStateType> {
  for await (const chunk of chunks) {
    if (Array.isArray((chunk as Partial<ExecutionStateType>).usage)) yield chunk;
  }
}

/** Spend a failure carries that the run's state does not hold yet. */
const unrecordedSpendOf = (error: unknown): readonly UsageRecord[] =>
  error instanceof PaidStepError || error instanceof LimitExceededError ? error.usage : [];

/** Drains the graph stream; a paid failure (agent, guard, router, an agent's limit) still records its spend. */
export function drainRun(
  states: AsyncIterable<ExecutionStateType>,
  record: (records: readonly UsageRecord[]) => Promise<void>,
  alreadyRecorded: readonly UsageRecord[] = [],
): Promise<ExecutionStateType> {
  return drainRecordingUsage(statesOnly(states), record, alreadyRecorded).catch(
    async (error: unknown) => {
      const unrecorded = unrecordedSpendOf(error);
      if (unrecorded.length > 0) await record(unrecorded);
      throw error;
    },
  );
}
