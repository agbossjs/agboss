/** Plain JSON facts an error carries into its record (`{ key, limit }`, `{ agent }`, …). */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/** What a framework error may take besides its message. */
export interface AGBossErrorOptions {
  readonly cause?: unknown;
  readonly details?: ErrorDetails;
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

  constructor(message: string, options: AGBossErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = new.target.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** The run was cancelled: its signal aborted, or a cancel was requested before a node ran. */
export class ExecutionCancelledError extends AGBossError {
  static override readonly code: string = "execution.cancelled";
  override name = "ExecutionCancelledError";
  constructor(message = "the execution was cancelled externally") {
    super(message);
  }
}

/**
 * A request refused because the app is stopping (#261): from `app.close()` on, `execute` and `resume`
 * are not accepted — running executions go on, `cancel` still works. Nothing was cancelled: the
 * request is refused before an execution starts (`onRunRejected` with `app.stopping`).
 */
export class ApplicationStoppingError extends AGBossError {
  static override readonly code: string = "app.stopping";
  override name = "ApplicationStoppingError";
}

// the rules of a key's text (#538, #547, #556) live in their own module, re-exported here
export { KEY_TEXT_RULE_TEXT, KeyTextRule, keyTextRuleOf } from "./key-text.js";
