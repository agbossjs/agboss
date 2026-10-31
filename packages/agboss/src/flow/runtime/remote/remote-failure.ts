import { durableErrorOf, recordedErrorOf } from "../../../core/error-record.js";

/**
 * A remote child's error across instances (#333 PR 2, #598): the worker keeps its durable record —
 * its class line by code, message and causes (`durableErrorOf`) — in the queue row; the parent's
 * step gets it back as a `RecordedError`, the cause of its `ChildExecutionFailedError` as a local
 * child's error is, routed by `.onError` as the original was: a side path on the child's own error
 * class is taken on every instance. A row written before #598 (names, codes and messages only) is
 * read back as `RemoteChildFailure`s, which match no project class — on every instance alike.
 */

/** A remote child's error (or one of its causes) of a row written before #598. */
export class RemoteChildFailure extends Error {
  constructor(
    readonly originalName: string,
    message: string,
    readonly code: string | undefined,
    cause?: RemoteChildFailure,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = originalName;
  }
}

/** How deep a legacy row's cause chain is read. */
const MAX_CAUSES = 5;

/** An error as the queue row's `failure` text: its durable record (#598). */
export const failureTextOf = (error: unknown): string => JSON.stringify(durableErrorOf(error));

const textField = (value: unknown, key: string): string | undefined => {
  const field: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "string" ? field : undefined;
};

function failureOf(value: unknown, depth: number): RemoteChildFailure {
  const cause: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "cause") : undefined;
  return new RemoteChildFailure(
    textField(value, "name") ?? "Error",
    textField(value, "message") ?? "the child failed on another instance",
    textField(value, "code"),
    cause === undefined || depth >= MAX_CAUSES ? undefined : failureOf(cause, depth + 1),
  );
}

/** The error a row's `failure` text names: rebuilt from its record, or a legacy row's names. */
export function remoteFailureOf(text: string | undefined): Error {
  const value: unknown = text === undefined ? undefined : JSON.parse(text);
  return recordedErrorOf(value) ?? failureOf(value, 1);
}
