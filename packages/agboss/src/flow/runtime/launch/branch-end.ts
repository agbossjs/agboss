import type { RunnableConfig } from "@langchain/core/runnables";
import { handedOverReason } from "../../../app/handed-over.js";
import { ExecutionCancelledError } from "../../../core/errors.js";
import { extractRunContext } from "../../../core/run-context.js";
import { StepFailedError } from "../../../graph/errors.js";
import { FailurePolicy } from "../../decorators/router.js";
import type { LiveLaunch } from "./launch-registry.js";
import { ArbiterError } from "./quorum-errors.js";
import { BranchStatus, type BranchTicket } from "./records.js";
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
 * `Skip`ped, never taken by `.onJoinError(…)`.
 */
export function passThroughStops(config: RunnableConfig | undefined, runId: string): void {
  const handedOver = handedOverReason(config?.signal);
  if (handedOver !== undefined) throw handedOver;
  if (executionSignalOf(config, runId).aborted || config?.signal?.aborted === true)
    throw new ExecutionCancelledError("the execution was cancelled during a parallel launch");
}
