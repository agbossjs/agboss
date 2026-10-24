/**
 * A remote child's error across instances (#333 PR 2): the worker keeps its name, `code`, message
 * and cause chain in the queue row; the parent's step gets it back as `RemoteChildFailure`s — the
 * cause of its `ChildExecutionFailedError`, as a local child's error is. The classes are not
 * carried: a side path matching the child's own error class by the cause chain is #333 PR 4.
 */

/** A remote child's error (or one of its causes) on its parent's instance. */
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

/** How deep a cause chain is kept. */
const MAX_CAUSES = 5;

interface FailureRecord {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: FailureRecord;
}

function recordOf(error: unknown, depth: number): FailureRecord {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const code: unknown = Reflect.get(error, "code");
  const cause: unknown = error.cause;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(cause === undefined || depth >= MAX_CAUSES ? {} : { cause: recordOf(cause, depth + 1) }),
  };
}

/** An error as the queue row's `failure` text. */
export const failureTextOf = (error: unknown): string => JSON.stringify(recordOf(error, 1));

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

/** The error a row's `failure` text names. */
export const remoteFailureOf = (text: string | undefined): RemoteChildFailure =>
  failureOf(text === undefined ? undefined : JSON.parse(text), 1);
