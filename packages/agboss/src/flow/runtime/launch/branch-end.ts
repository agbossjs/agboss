import type { RunnableConfig } from "@langchain/core/runnables";
import { handedOverOf } from "../../../app/handed-over.js";
import { ExecutionCancelledError } from "../../../core/errors.js";
import { extractRunContext } from "../../../core/run-context.js";
import { StepFailedError } from "../../../graph/errors.js";
import { LimitExceededError } from "../../../graph/limits.js";
import { FailurePolicy } from "../../decorators/router.js";
import type { LiveLaunch } from "./launch-registry.js";
import { ArbiterError } from "./quorum-errors.js";
import { BranchStatus, type BranchOutcomeRecord, type BranchTicket } from "./records.js";
import type { ErrorRecord } from "../../../core/error-record.js";
import type { NodeValue } from "../scope.js";
import type { QuorumMark } from "./quorum-branch.js";
import { isWithdrawn } from "./withdrawn-pauses.js";

/**
 * How a branch that threw ended (#273 S21, #279): `Cancelled` when its launch was aborted first (a
 * sibling failed, the quorum was decided, the deadline passed) or its pause was withdrawn (#267); `Skipped` for its own step failure
 * under `FailurePolicy.Skip` — or under a quorum, where a failed branch only leaves its place empty;
 * `Failed` for anything else (a limit, an `ArbiterError`), which aborts the launch. A hand-over and a
 * cancel of the execution are no outcome of the branch: they stop the whole execution.
 */

/** Where a branch threw: its launch in this process, its ticket, whether its launch has a quorum. */
export interface BranchFailureSite {
  readonly live: LiveLaunch;
  readonly ticket: BranchTicket;
  readonly isQuorum: boolean;
}

/** The status of a branch that threw `error`. */
export function failedStatusOf(site: BranchFailureSite, error: unknown): BranchStatus {
  if (site.live.controller.signal.aborted || isWithdrawn(error)) return BranchStatus.Cancelled;
  if (error instanceof ArbiterError || !(error instanceof StepFailedError))
    return BranchStatus.Failed;
  const isDropped = site.ticket.failure === FailurePolicy.Skip || site.isQuorum;
  return isDropped ? BranchStatus.Skipped : BranchStatus.Failed;
}

/** The execution's own signal (`app.cancel`, the caller's signal, a hand-over), not the launch's. */
export const executionSignalOf = (config: RunnableConfig | undefined, runId: string): AbortSignal =>
  extractRunContext(config, runId).run.signal;

/**
 * A hand-over and a cancel of the execution (S21): thrown as they are — never recorded, never
 * `Skip`ped, never taken by `.onJoinError(…)`. A fenced write behind the branch's `error` (#471) is a
 * hand-over too, and wins over the signal's reason.
 */
export function passThroughStops(
  config: RunnableConfig | undefined,
  runId: string,
  error?: unknown,
): void {
  const handedOver = handedOverOf(error, config?.signal);
  if (handedOver !== undefined) throw handedOver;
  if (executionSignalOf(config, runId).aborted || config?.signal?.aborted === true)
    throw new ExecutionCancelledError("the execution was cancelled during a parallel launch");
}

/** How a branch ended, as its record keeps it. */
export interface EndedBranch {
  readonly status: BranchStatus;
  readonly value?: NodeValue;
  readonly read: readonly string[];
  readonly error?: ErrorRecord;
  readonly mark?: QuorumMark;
}

/** The branch's outcome record: what the join reads. */
export const branchRecordOf = (
  launchId: string,
  index: number,
  end: EndedBranch,
): BranchOutcomeRecord => ({
  launchId,
  index,
  status: end.status,
  ...(end.value === undefined ? {} : { value: end.value }),
  read: end.read,
  ...(end.error === undefined ? {} : { error: end.error }),
  ...end.mark,
});

/**
 * The errors of failed branches across the passes of one process (#267 AC10): a `FailFast`
 * failure withdraws its paused siblings, and the join runs in the next pass — a new graph, a new
 * registry — so the error the branch threw is kept here, as it was thrown, for the join to route
 * (`.onJoinError`) and rethrow. One per workflow of an application instance; a launch's entries go
 * with its join, an execution's with its tree. Another instance has the branch's record only.
 */
export class BranchErrors {
  readonly #errors = new Map<string, unknown>();

  keep(launchId: string, index: number, error: unknown): void {
    this.#errors.set(`${launchId}#${String(index)}`, error);
  }

  /** The error the branch threw, when this process ran it. */
  find(launchId: string, index: number): unknown {
    return this.#errors.get(`${launchId}#${String(index)}`);
  }

  /** Forgets a launch's errors (its join read them). */
  forgetLaunch(launchId: string): void {
    for (const key of this.#errors.keys())
      if (key.startsWith(`${launchId}#`)) this.#errors.delete(key);
  }

  /** Forgets an execution's errors (its tree ended); a launch id starts with the execution's id. */
  forgetExecution(executionId: string): void {
    for (const key of this.#errors.keys()) {
      if (key.startsWith(`${executionId}:`)) this.#errors.delete(key);
    }
  }
}

/**
 * What a branch failed with (#338): stopped by an exhausted budget, the `BudgetExceededError` that
 * aborted its calls — whatever error the abort surfaced as —; else (its own limit too) its error.
 */
export const failureOfBranch = (budgetStop: AbortSignal | undefined, error: unknown): unknown =>
  budgetStop?.aborted === true && !(error instanceof LimitExceededError)
    ? (budgetStop.reason as unknown)
    : error;
