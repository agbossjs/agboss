import type { ErrorRecord } from "../error-record.js";
import { ApplicationStoppingError } from "../errors.js";
import { ExecutionError, ExecutionErrorKind } from "./run-errors.js";

/**
 * The kinds of `ExecutionError` that are a hand-over, not a failure (#265, #471): an external system fenced one
 * of its writes (a lost lease and a stopping application are the standalone `ExecutionLeaseLostError` and
 * `ApplicationStoppingError`, found by their codes). Another instance continues the tree: such an error reaches neither `.onError` nor the
 * record — so a user's `.onError(ExecutionError, …)` never catches it and a stale worker cannot hold on
 * to a lease it lost.
 */
export const HAND_OVER_KINDS: ReadonlySet<ExecutionErrorKind> = new Set([
  ExecutionErrorKind.Fenced,
]);

/** The codes of those kinds: what a record's class line names. */
const HAND_OVER_CODES: ReadonlySet<string> = new Set([
  ExecutionError.Fenced.code,
  // the standalone classes the runtime throws: a lost lease (also before the run started) and a stop
  "execution.lease-lost",
  "execution.lease-lost.not-started",
  ApplicationStoppingError.code,
]);

/** Whether `error` is an `ExecutionError` of a hand-over kind. */
export const isHandOverError = (error: unknown): error is ExecutionError =>
  error instanceof ExecutionError && HAND_OVER_KINDS.has(error.kind);

/** Whether a record's class line holds a hand-over code: no `.onError` takes it. */
export const isHandOverRecord = (record: ErrorRecord): boolean =>
  record.lineage.some((code) => HAND_OVER_CODES.has(code));
