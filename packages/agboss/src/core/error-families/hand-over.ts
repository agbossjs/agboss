import type { ErrorRecord } from "../error-record.js";
import { ExecutionError, ExecutionErrorKind } from "./run-errors.js";

/**
 * The kinds of `ExecutionError` that are a hand-over, not a failure (#265, #471): the instance lost the
 * tree's lease, an external system fenced one of its writes, the application
 * is stopping. Another instance continues the tree: such an error reaches neither `.onError` nor the
 * record — so a user's `.onError(ExecutionError, …)` never catches it and a stale worker cannot hold on
 * to a lease it lost.
 */
export const HAND_OVER_KINDS: ReadonlySet<ExecutionErrorKind> = new Set([
  ExecutionErrorKind.LeaseLost,
  ExecutionErrorKind.Fenced,
  ExecutionErrorKind.ApplicationStopping,
]);

/** The codes of those kinds: what a record's class line names. */
const HAND_OVER_CODES: ReadonlySet<string> = new Set([
  ExecutionError.LeaseLost.code,
  ExecutionError.Fenced.code,
  ExecutionError.ApplicationStopping.code,
]);

/** Whether `error` is an `ExecutionError` of a hand-over kind. */
export const isHandOverError = (error: unknown): error is ExecutionError =>
  error instanceof ExecutionError && HAND_OVER_KINDS.has(error.kind);

/** Whether a record's class line holds a hand-over code: no `.onError` takes it. */
export const isHandOverRecord = (record: ErrorRecord): boolean =>
  record.lineage.some((code) => HAND_OVER_CODES.has(code));
