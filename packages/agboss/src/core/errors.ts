import type { CancelledErrorCode } from "./cancelled-error-code.js";
import type { ErrorFormatOptions } from "./diagnostics/error-report.js";
import type { AGBossErrorOptions, ErrorDetails, MessageErrorOptions } from "./error-options.js";
import type { ExecutionSpanFrame } from "./diagnostics/span-trace.js";
import type { LabeledSpan, SourceSpan } from "./diagnostics/source-span.js";
import { installReportMembers, keepDiagnostics } from "./diagnostics/report-members.js";

export * from "./error-options.js";
export * from "./key-text-rule.js";

/** The options of `ExecutionCancelledError`: the message is optional. */
export interface ExecutionCancelledErrorOptions extends AGBossErrorOptions {
  readonly message?: string;
}

/**
 * The base of every error the framework throws at run time. Each class has a stable `code`
 * (`static code`, also on the instance) — what `catchError` matches and what an error record keeps
 * after a checkpoint. A subclass's code extends its parent's (`limit` → `limit.budget`), so catching
 * the parent catches the child. Catch `Error` to catch everything.
 */
export class AGBossError extends Error {
  static readonly code: string = "agboss";
  readonly code: string;
  readonly details?: ErrorDetails;
  // what the error reports about itself (#1325c): installed on the prototype below, beside the class
  /** Where it was thrown in the user's source: set by the thrower, else the first frame of its stack outside the framework. */
  declare readonly location: SourceSpan | undefined;
  /** Other places in the user's source that explain it, with the words that say how. */
  declare readonly secondarySpans: readonly LabeledSpan[];
  /** What the execution was doing when it was made, innermost first (kept across `await`). */
  declare readonly spanTrace: readonly ExecutionSpanFrame[];
  /** Facts about it that are not its message. */
  declare readonly notes: readonly string[];
  /** What to do about it: one sentence. */
  declare readonly help: string | undefined;
  /** The lines of code that make the change `help` asks for. */
  declare readonly suggestionPatch: string | undefined;
  /** It and its causes, outermost first. */
  declare readonly chain: () => readonly Error[];
  /**
   * The report: the numbered chain, `Location:`, `Span trace:`, `Stack backtrace:` (per
   * `AGBOSS_BACKTRACE=0|1|full`), the suggestion and notes — what `console.log(error)` prints. It never
   * prints `details`, a field of an error, or the message of an error that is not the framework's own.
   */
  declare readonly format: (options?: ErrorFormatOptions) => string;

  constructor(message: string, options: AGBossErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = new.target.code;
    this.details = options.details;
    keepDiagnostics(this, options);
  }
}

installReportMembers(AGBossError.prototype, (error) => error instanceof AGBossError);

/** The run was cancelled: its signal aborted, or a cancel was requested before a node ran. */
export class ExecutionCancelledError extends AGBossError {
  static override readonly code: string = "execution.cancelled";
  /** This class's code, or its subclass `ExecutionCancelFencedError`'s (#909: `switch (error.code)` narrows). */
  declare readonly code: CancelledErrorCode;
  override name = "ExecutionCancelledError";

  constructor(options: ExecutionCancelledErrorOptions = {}) {
    const { message = "the execution was cancelled externally", ...rest } = options;
    super(message, rest);
  }
}

/**
 * A request refused because the app is stopping (#261): from `app.close()` on, `execute` and `resume`
 * are not accepted — running executions go on, `cancel` still works. Nothing was cancelled: the
 * request is refused before an execution starts (`onRunRejected` with `app.stopping`).
 */
export class ApplicationStoppingError extends AGBossError {
  static override readonly code = "app.stopping" as const;
  declare readonly code: typeof ApplicationStoppingError.code;
  override name = "ApplicationStoppingError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}
