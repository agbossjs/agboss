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

/** At most this long: a thread id or a business key is a key, not data (#262 Q4, #508). */
const MAX_KEY_LENGTH = 200;

/**
 * The rules of a key's text (#538): a thread id and a business key identify a charge, so two strings
 * that look the same — to a person, or to the system that made them — must never be two keys. The
 * first rule a text breaks; an error names it, never the text.
 */
export enum KeyTextRule {
  /** 1 to 200 UTF-16 code units. */
  Length = "length",
  /** No control character: C0 (U+0000–U+001F), U+007F, C1 (U+0080–U+009F) — Unicode `Cc`. */
  ControlCharacter = "control-character",
  /**
   * No format character (Unicode `Cf`): zero-width space and joiners (U+200B–U+200D), marks and bidi
   * controls (U+200E–U+200F, U+202A–U+202E, U+2066–U+2069), U+FEFF, the soft hyphen, tag characters, …
   * — invisible, so "order:42" and "order:\u200B42" would be two charges of one order.
   */
  FormatCharacter = "format-character",
  /**
   * No half of a surrogate pair standing alone: no character. SQLite and PostgreSQL keep text as
   * UTF-8, where it becomes U+FFFD — two keys would be one row — and `encodeURIComponent` throws on it.
   */
  LoneSurrogate = "lone-surrogate",
  /**
   * In Unicode normalization form C: "é" as U+00E9, never as "e" + U+0301. Refused, never normalized
   * silently — a key changed on its way in would no longer replay the effect stored under it.
   */
  NotNfc = "not-nfc",
}

/** What each rule asks, as an error says it (the text itself is never named). */
export const KEY_TEXT_RULE_TEXT: Readonly<Record<KeyTextRule, string>> = {
  [KeyTextRule.Length]: `it must be 1 to ${String(MAX_KEY_LENGTH)} characters (UTF-16 code units)`,
  [KeyTextRule.ControlCharacter]:
    "it contains a control character (C0 U+0000–U+001F, U+007F or C1 U+0080–U+009F)",
  [KeyTextRule.FormatCharacter]:
    "it contains a format character (Unicode Cf: zero-width space or joiner, a bidi control, U+FEFF, a soft hyphen, …)",
  [KeyTextRule.LoneSurrogate]: "it contains a lone surrogate (half of a UTF-16 pair, no character)",
  [KeyTextRule.NotNfc]:
    'it is not in Unicode normalization form C (NFC): normalize it with text.normalize("NFC") where it is made',
};

const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
const LONE_SURROGATE = /\p{Cs}/u;

/** The first rule of a key's text (#538) that `text` breaks; `undefined` when it is a key. */
export function keyTextRuleOf(text: string): KeyTextRule | undefined {
  if (text.length === 0 || text.length > MAX_KEY_LENGTH) return KeyTextRule.Length;
  if (LONE_SURROGATE.test(text)) return KeyTextRule.LoneSurrogate;
  if (CONTROL.test(text)) return KeyTextRule.ControlCharacter;
  if (FORMAT.test(text)) return KeyTextRule.FormatCharacter;
  if (text.normalize("NFC") !== text) return KeyTextRule.NotNfc;
  return undefined;
}
