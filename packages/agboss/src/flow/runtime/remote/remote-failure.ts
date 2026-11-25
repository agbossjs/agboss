import { StoreError } from "../../../core/error-families/store-errors.js";
import { durableErrorOf, recordedErrorOf } from "../../../core/error-record.js";
import { parsedStoredJson } from "../../../infrastructure/stored-step.js";

/**
 * A remote child's error across instances (#333 PR 2, #598): the worker keeps its durable record —
 * its class line by code, message and causes (`durableErrorOf`) — in the queue row; the parent's
 * step gets it back as a `RecordedError`, the cause of its `ChildExecutionFailedError` as a local
 * child's error is, routed by `.onError` as the original was: a side path on the child's own error
 * class is taken on every instance. A row whose `failure` is no durable record (a row of 0.1.0, which
 * kept names and messages only) is refused, never read as a failure of no class.
 */

/** An error as the queue row's `failure` text: its durable record (#598). */
export const failureTextOf = (error: unknown): string => JSON.stringify(durableErrorOf(error));

/** The error a row's `failure` text names, rebuilt from its record; `StoreError.UnreadableRecord` for any other text. */
export function remoteFailureOf(text: string | undefined): Error {
  const value: unknown =
    text === undefined ? undefined : parsedStoredJson({ what: "child failure", text });
  const recorded = recordedErrorOf(value);
  if (recorded === undefined)
    throw new StoreError.UnreadableRecord({ record: "child failure", ids: "", fields: "failure" });
  return recorded;
}
