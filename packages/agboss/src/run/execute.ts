import { WorkflowCancelledError } from "../core/errors.js";
import { handedOverReason, isHandedOver } from "../app/handed-over.js";
import { drainRecordingUsage } from "../finops/record-stream.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { ExecutionGraph, RunLimits } from "../flow/runtime/build.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { PaidStepError } from "../graph/errors.js";
import { BudgetExceededError, LimitExceededError, type LimitBreach } from "../graph/limits.js";
import type { WorkflowLimits } from "../graph/settings.js";
import type { NewTern, TernOutcome } from "../terns/index.js";
import { usd } from "../units/index.js";
import { reserveSpend, type SpendHold } from "../finops/reservations.js";
import { checkRunLimits } from "../app/limit-check.js";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { RunDeps, SpendAccount } from "./types.js";

export type TernBase = Pick<
  NewTern,
  | "runId"
  | "threadId"
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
  readonly deps: RunDeps<TName>;
  readonly graph: ExecutionGraph;
  readonly base: TernBase;
  readonly runId: string;
  readonly budgetUsd: number;
  /** Where spend goes as it happens: the run's ledger account. */
  readonly record: (records: readonly UsageRecord[]) => Promise<void>;
  /** How many of the run's usage records are already in the ledger. */
  readonly recorded: number;
  readonly callbacks: BaseCallbackHandler[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A run stopped by its signal reads as cancelled, whatever error the abort surfaced as — or, when
 * its instance lost the tree's lease or stopped, as `ExecutionLeaseLostError` /
 * `ApplicationStoppingError` (not a failure, #265).
 */
export const outcomeError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  const handedOver = handedOverReason(signal);
  if (handedOver !== undefined) return handedOver;
  return signal?.aborted === true && !(error instanceof WorkflowCancelledError)
    ? new WorkflowCancelledError("the run was cancelled")
    : error;
};

/**
 * Writes the failed record of a run that failed (#265: a lost lease or an interruption writes
 * nothing — the record stays `running`, another instance owns it) and returns the error to throw.
 */
export async function recordFailure(
  error: unknown,
  write: () => Promise<unknown>,
): Promise<unknown> {
  if (!isHandedOver(error)) await write();
  return error;
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

/** Writes spend to the account's ledger through the run's hold as it happens; remembers it for the Tern. */
export function recorder(
  hold: Pick<SpendHold, "record">,
  spent: UsageRecord[],
): (records: readonly UsageRecord[]) => Promise<void> {
  return async (records) => {
    spent.push(...records);
    await hold.record(records);
  };
}

/** The account a run pays from: the workflow's own, its daily cap `limits.perDay.cost`. */
export const workflowAccount = <TName extends string>(deps: RunDeps<TName>): SpendAccount => ({
  key: deps.config.name,
  dailyCap: deps.limits.perDay?.cost ?? Number.POSITIVE_INFINITY,
});

/** What a run may spend, the limits the flow holds it to, and its hold on the account's day. */
export interface RunBudget {
  readonly budgetUsd: number;
  readonly run: RunLimits;
  readonly hold: SpendHold;
}

const limitsFor = (limits: WorkflowLimits, account: SpendAccount): WorkflowLimits => ({
  ...(limits.perRun === undefined ? {} : { perRun: limits.perRun }),
  ...(Number.isFinite(account.dailyCap) ? { perDay: { cost: usd(account.dailyCap) } } : {}),
});

/**
 * Run budget = run cap ∩ what is left of the account's day, **reserved** before the first call
 * (#202): the day's spend and the other runs' holds count, so concurrent runs never jointly pass
 * the cap. Nothing left → no calls at all. The flow's day check starts from the committed amount.
 */
export async function allowedBudget<TName extends string>(
  deps: RunDeps<TName>,
  account: SpendAccount,
): Promise<RunBudget> {
  if (Number.isFinite(account.dailyCap)) checkRunLimits(deps.config.name, deps.limits);
  const want = deps.limits.perRun?.cost ?? Number.POSITIVE_INFINITY;
  const hold = await reserveSpend(deps.ledger, account, want);
  if (hold.grantedUsd <= 0) {
    hold.release();
    const breach: LimitBreach = {
      key: "limits.perDay.cost",
      limit: account.dailyCap,
      actual: hold.committedUsd,
    };
    throw new BudgetExceededError(breach, [], 0);
  }
  const committed = hold.committedUsd;
  return {
    budgetUsd: hold.grantedUsd,
    run: { limits: limitsFor(deps.limits, account), spentToday: () => Promise.resolve(committed) },
    hold,
  };
}

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
  alreadyRecorded = 0,
): Promise<ExecutionStateType> {
  return drainRecordingUsage(statesOnly(states), record, alreadyRecorded).catch(
    async (error: unknown) => {
      const unrecorded = unrecordedSpendOf(error);
      if (unrecorded.length > 0) await record(unrecorded);
      throw error;
    },
  );
}
