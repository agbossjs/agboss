import { AGBossError } from "../../core/errors.js";

/** What an async work refused knows (#906): the effect. */
export interface SyncWorkRequiredErrorOptions {
  readonly effect: string;
  readonly cause?: unknown;
}

/**
 * A fenced effect on SQLite returned a promise (#500): its transaction is one synchronous group of
 * statements on the instance's connection, so it is rolled back — nothing written, the result not
 * stored. Do the step's I/O before the call (its input) or after it (with its result), and write
 * the rows with the given `DatabaseSync` only.
 */
export class SyncWorkRequiredError extends AGBossError {
  static override readonly code = "fenced-effect.sync-work-required" as const;
  declare readonly code: typeof SyncWorkRequiredError.code;
  override name = "SyncWorkRequiredError";
  readonly effect: string;

  constructor(options: SyncWorkRequiredErrorOptions) {
    const { effect, cause } = options;
    super(
      `fenced effect "${effect}" returned a promise: a SQLite fenced effect runs its work synchronously in one transaction — nothing was written; do the I/O before or after the call`,
      { cause },
    );
    this.effect = effect;
  }
}
