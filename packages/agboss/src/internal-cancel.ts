// the aborts of a cancel, a stop and a pause (#1341): internal reasons of an `AbortSignal`, never caught by a flow
export { ExecutionCancelledError, type ExecutionCancelledErrorOptions } from "./core/errors.js";
export { isExecutionCancelled } from "./core/execution-cancelled.js";
export {
  ExecutionPausedError,
  ExecutionPauseFencedError,
  ExecutionStopFencedError,
  ExecutionStoppedError,
} from "./app/lease-stopped.js";
