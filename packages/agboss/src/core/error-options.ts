import type { ErrorDiagnostics } from "./diagnostics/error-report.js";

/** Plain JSON facts an error carries into its record (`{ key, limit }`, `{ agent }`, …). */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/**
 * What a framework error may take besides its message. `location`, `secondarySpans`, `notes`, `help`
 * and `suggestionPatch` are what its report (`error.format()`) shows (#1325c): the framework's own
 * words about the user's code, never a value of a run.
 */
export interface AGBossErrorOptions extends ErrorDiagnostics {
  readonly cause?: unknown;
  readonly details?: ErrorDetails;
}

/**
 * What an error that has nothing to say but its message takes (#906): `new X({ message, cause })`.
 * Every error the framework throws is made from one options object — its keys are the error's own
 * properties, `cause` among them; `message` is the one fact of an error with no other.
 */
export interface MessageErrorOptions extends AGBossErrorOptions {
  readonly message: string;
}

/**
 * What an error that extends a platform class (`RangeError`) or `Error` itself takes (#906): `{ message,
 * cause }`, the one fact and the cause — the shape of `MessageErrorOptions` without `details`.
 */
export interface PlainErrorOptions {
  readonly message: string;
  readonly cause?: unknown;
}

/** `{ cause }` for a native `Error` constructor, nothing when there is no cause (#906). */
export const causeOptionOf = (cause: unknown): ErrorOptions | undefined =>
  cause === undefined ? undefined : { cause };
