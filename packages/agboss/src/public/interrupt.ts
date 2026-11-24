/** Stopping and interrupting an execution (#1341b): `app.stop`, `InterruptMode`, `InterruptReason`. */
export {
  InterruptMode,
  InterruptReason,
  StopRequestState,
  type StopOptions,
  type StopOutput,
} from "../app/interrupt-types.js";
export type { InterruptCleanup } from "../flow/context/interrupt-cleanup.js";
export type { CancelledErrorCode } from "../core/cancelled-error-code.js";
