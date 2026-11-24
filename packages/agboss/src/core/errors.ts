import { KEY_TEXT_RULE_TEXT, KeyTextRule } from "./key-text-rule.js";
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

/** What `InvalidMintedIdError` names (#890: one options bag, its keys its fields). */
export interface InvalidMintedIdErrorOptions {
  readonly generator: string;
  readonly method: "newThreadId" | "newExecutionId";
  readonly rule: KeyTextRule;
  readonly cause?: unknown;
}

/**
 * An id the application's `IdGenerator` minted that is no key's text (#578): a thread id or an
 * execution id keys threads, leases, the audit log and fenced effects like an id that comes in, so
 * it is held to the same rules at the mint — never used, never stored. Names the generator's class,
 * the method and the rule, never the id (a non-string is `length`).
 */
export class InvalidMintedIdError extends AGBossError {
  static override readonly code = "run.invalid-minted-id" as const;
  declare readonly code: typeof InvalidMintedIdError.code;
  override name = "InvalidMintedIdError";
  /** The generator's class name. */
  readonly generator: string;
  /** The method that minted the id. */
  readonly method: "newThreadId" | "newExecutionId";
  /** The first rule the id breaks. */
  readonly rule: KeyTextRule;

  constructor(options: InvalidMintedIdErrorOptions) {
    const { generator, method, rule, cause } = options;
    super(
      `${generator}.${method}() minted an id that is no key (${rule}): ${KEY_TEXT_RULE_TEXT[rule]} — fix the IdGenerator`,
      { cause, details: { generator, method, rule } },
    );
    this.generator = generator;
    this.method = method;
    this.rule = rule;
  }
}

/** What `DuplicateExecutionIdError` names. */
export interface DuplicateExecutionIdErrorOptions {
  /** The generator's class name. */
  readonly generator: string;
  readonly cause?: unknown;
}

/**
 * An execution id the application's `IdGenerator` minted that an earlier execution already has
 * (#591) — a root, a child or a recursion level, of any tenant, running, finished, failed or
 * cancelled: the new execution would share that tree's lease, fencing token, audit log and step
 * keys, so a fenced effect or an outbound call would replay the other tree's result. Refused before
 * anything of it is written or run. Names the generator's class, never the id.
 */
export class DuplicateExecutionIdError extends AGBossError {
  /** `run.duplicate-execution-id`. */
  static override readonly code = "run.duplicate-execution-id" as const;
  declare readonly code: typeof DuplicateExecutionIdError.code;
  /** `DuplicateExecutionIdError`. */
  override name = "DuplicateExecutionIdError";
  /** The generator's class name. */
  readonly generator: string;

  constructor(options: DuplicateExecutionIdErrorOptions) {
    const { generator, cause } = options;
    super(
      `${generator}.newExecutionId() minted an execution id another execution already has — an IdGenerator never repeats an id over the life of the application's stores`,
      { cause, details: { generator, method: "newExecutionId" } },
    );
    this.generator = generator;
  }
}

/** What `ThreadIdsExhaustedError` names. */
export interface ThreadIdsExhaustedErrorOptions {
  /** The generator's class name. */
  readonly generator: string;
  /** How many minted ids were tried. */
  readonly tries: number;
  readonly cause?: unknown;
}

/**
 * A new thread for which the application's `IdGenerator` minted only ids the tenant already has
 * (#613, after #550): each taken one is skipped and the next minted, up to `tries`, then this — a
 * generator stuck on one id, or a sequential one restarted on a kept database. No thread is shared
 * and none is written. Names the generator's class and the tries, never an id (#890: it was
 * `DuplicateThreadIdError`, but it is raised after `tries` duplicates, never on one).
 */
export class ThreadIdsExhaustedError extends AGBossError {
  /** `run.thread-ids-exhausted`. */
  static override readonly code = "run.thread-ids-exhausted" as const;
  declare readonly code: typeof ThreadIdsExhaustedError.code;
  /** `ThreadIdsExhaustedError`. */
  override name = "ThreadIdsExhaustedError";
  /** The generator's class name. */
  readonly generator: string;
  /** How many minted ids were tried. */
  readonly tries: number;

  constructor(options: ThreadIdsExhaustedErrorOptions) {
    const { generator, tries, cause } = options;
    super(
      `${generator}.newThreadId() minted ${String(tries)} ids in a row that are threads the tenant has — an IdGenerator never repeats an id over the life of the application's stores`,
      { cause, details: { generator, method: "newThreadId", tries } },
    );
    this.generator = generator;
    this.tries = tries;
  }
}

export class UnknownThreadError extends AGBossError {
  static override readonly code = "run.unknown-thread" as const;
  declare readonly code: typeof UnknownThreadError.code;
  override name = "UnknownThreadError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** A thread used by a caller that is not its owner (`execute`, `resume`, `cancel` with `ownerId`). */
export class ThreadOwnerError extends AGBossError {
  static override readonly code = "run.thread-owner" as const;
  declare readonly code: typeof ThreadOwnerError.code;
  override name = "ThreadOwnerError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** What an invalid thread id knows (#906): the rule it breaks — never the id. */
export interface InvalidThreadIdErrorOptions {
  readonly rule: KeyTextRule;
  readonly cause?: unknown;
}

/**
 * A thread id a caller picked that cannot be one (#538): the rule of a key's text it breaks
 * (`rule`), named in the message — never the id.
 */
export class InvalidThreadIdError extends AGBossError {
  static override readonly code = "run.invalid-thread-id" as const;
  declare readonly code: typeof InvalidThreadIdError.code;
  override name = "InvalidThreadIdError";
  readonly rule: KeyTextRule;

  constructor(options: InvalidThreadIdErrorOptions) {
    const { rule, cause } = options;
    super(`Not a thread id (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`, { cause, details: { rule } });
    this.rule = rule;
  }
}
