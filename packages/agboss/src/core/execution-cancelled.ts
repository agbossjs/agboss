import { ExecutionCancelledError } from "./errors.js";
import { ExecutionError } from "./error-families/run-errors.js";

/**
 * Whether `error` ends its tree as cancelled: a cancel or a stop (`ExecutionCancelledError`, internal)
 * or a write refused after its tree's cancel (`ExecutionError.CancelFenced`). The one test every place
 * that unwinds a cancelled tree asks.
 */
export const isExecutionCancelled = (
  error: unknown,
): error is ExecutionCancelledError | ExecutionError.CancelFenced =>
  error instanceof ExecutionCancelledError || error instanceof ExecutionError.CancelFenced;
