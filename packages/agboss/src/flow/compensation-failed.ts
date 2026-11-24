import { AGBossError } from "../core/errors.js";
import type { CompensationRecord } from "./compensation.js";

/** What a failed automatic undo takes (#906): the undos that threw, and the error that started it. */
export interface CompensationFailedErrorOptions {
  /** The undo actions that threw. */
  readonly failures: readonly CompensationRecord[];
  /** The error that started the undo (`toFailWith(Original)` matches through it). */
  readonly cause?: unknown;
}

/**
 * An automatic undo failed (#340 Q4): every other undo still ran, then the execution fails with
 * this error — `failures` are the undo actions that threw, `cause` the error that started the undo
 * (`toFailWith(Original)` matches through it). Never taken by `.onError`.
 */
export class CompensationFailedError extends AGBossError {
  /** `compensation.failed`. */
  static override readonly code = "compensation.failed" as const;
  declare readonly code: typeof CompensationFailedError.code;
  override name = "CompensationFailedError";
  /** The undo actions that failed, newest first (each `CompensationStatus.Failed`). */
  readonly failures: readonly CompensationRecord[];

  constructor(options: CompensationFailedErrorOptions) {
    const { failures, cause } = options;
    const undone = failures.map(
      (f) =>
        `${f.compensator.name} (compensates ${f.compensated.component.name}): ${f.error?.message ?? "failed"}`,
    );
    super(`An automatic undo failed — ${undone.join("; ")}; the others ran`, { cause });
    this.failures = failures;
  }
}
