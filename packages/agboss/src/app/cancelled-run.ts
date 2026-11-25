import { ExecutionCancelledError } from "../core/errors.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { TurnOutcome } from "../turns/index.js";
import type { Usd } from "../units/index.js";

/** Why a thread's execution stopped when it was cancelled — on its own instance or another (#360). */
export const cancelledErrorOf = (threadId: string): ExecutionCancelledError =>
  new ExecutionCancelledError({ message: `thread "${threadId}" was cancelled` });

/** The reason a cancelled execution's record gives. */
export const CANCELLED_STOP_REASON = "the run was cancelled";

/** The Turn outcome of a cancelled execution: the path it took and what it cost (#1341: `cancelled`). */
export const cancelledRecordOutcome = (route: readonly string[], costUsd: Usd): TurnOutcome => ({
  replyWith: "",
  status: "cancelled",
  stopReason: CANCELLED_STOP_REASON,
  route,
  steps: [],
  costUsd,
});

/** The Turn outcome of a paused run that was cancelled instead of resumed. */
export const cancelledOutcome = (run: AgentExecutionOutput): TurnOutcome =>
  cancelledRecordOutcome(run.path, run.cost.totalUsd);
