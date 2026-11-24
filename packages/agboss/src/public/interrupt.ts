/** Stopping and interrupting an execution (#1341b): `app.stop`, `app.pause`, `app.unpause`, `InterruptMode`, `InterruptReason`. */
export {
  InterruptMode,
  InterruptReason,
  PauseRequestState,
  StopRequestState,
  type PauseExecutionOptions,
  type PauseOutput,
  type StopOptions,
  type StopOutput,
  type UnpauseExecutionOptions,
} from "../app/interrupt-types.js";
export type { InterruptCleanup } from "../flow/context/interrupt-cleanup.js";
export type { CancelledErrorCode } from "../core/cancelled-error-code.js";
