/** Plain JSON facts an error carries into its record (`{ key, limit }`, `{ agent }`, …). */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/** What a framework error may take besides its message. */
export interface AGBossErrorOptions {
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

  constructor(message: string, options: AGBossErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = new.target.code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** The run was cancelled: its signal aborted, or a cancel was requested before a node ran. */
export class ExecutionCancelledError extends AGBossError {
  static override readonly code = "execution.cancelled" as const;
  declare readonly code: typeof ExecutionCancelledError.code;
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

/** At most this long: a thread id or a business key is a key, not data (#262 Q4, #508). */
const MAX_KEY_LENGTH = 200;

/**
 * The rules of a key's text (#538): a thread id, a business key and a tenant id identify a charge,
 * so two strings that look the same — to a person, or to the system that made them — must never be
 * two keys. An error names the rule, never the text; a text that breaks several is named by the
 * first of them in the order declared here (#547 acceptance), wherever in the text each breach
 * stands.
 */
export enum KeyTextRule {
  /** 1 to 200 UTF-16 code units. */
  Length = "length",
  /**
   * No half of a surrogate pair standing alone: no character. SQLite and PostgreSQL keep text as
   * UTF-8, where it becomes U+FFFD — two keys would be one row — and `encodeURIComponent` throws on it.
   */
  LoneSurrogate = "lone-surrogate",
  /** No control character: C0 (U+0000–U+001F), U+007F, C1 (U+0080–U+009F) — Unicode `Cc`. */
  ControlCharacter = "control-character",
  /**
   * No format character (Unicode `Cf`): zero-width space and joiners (U+200B–U+200D), marks and bidi
   * controls (U+200E–U+200F, U+202A–U+202E, U+2066–U+2069), U+FEFF, the soft hyphen, tag characters, …
   * — invisible, so "order:42" and "order:\u200B42" would be two charges of one order.
   */
  FormatCharacter = "format-character",
  /**
   * No space but U+0020 (#547): no other Unicode space separator (`Zs`: U+00A0, U+2000–U+200A,
   * U+202F, U+205F, U+3000, …), no line or paragraph separator (U+2028, U+2029) — "order 42" with a
   * no-break space looks like the one with a space.
   */
  SpaceSeparator = "space-separator",
  /**
   * U+0020 only single and inside (#547): none at the start or the end, never two in a row —
   * upstream systems differ in whether they trim and collapse spaces.
   */
  Spacing = "spacing",
  /**
   * No character Unicode says renders as nothing (#556, `Default_Ignorable_Code_Point`, whatever its
   * category): the combining grapheme joiner U+034F, the Hangul fillers (U+115F, U+1160, U+3164,
   * U+FFA0), the variation selectors (U+FE00–U+FE0F — the emoji ones too: "❤\uFE0F" is "❤" + U+FE0F —,
   * U+E0100–U+E01EF), the Mongolian free variation selectors, U+17B4 / U+17B5, and the code points
   * Unicode reserves as such — "order:4\u034F2" would be a second charge of "order:42".
   */
  Ignorable = "ignorable",
  /**
   * No private-use character (`Co`: U+E000–U+F8FF, planes 15 and 16) and no noncharacter
   * (U+FDD0–U+FDEF, U+xFFFE and U+xFFFF of every plane) (#556): no meaning a person or another
   * system shares — each font and each system renders, maps or drops them its own way.
   */
  PrivateOrNoncharacter = "private-or-noncharacter",
  /**
   * No code point unassigned in this runtime's Unicode (`Cn`, #556): a later runtime may make it a
   * format character or give it a decomposition, and refuse a key stored before a rolling upgrade.
   * A code point never becomes unassigned again, so this rule never refuses a key it accepted
   * before; NFC is stable for assigned characters too (Unicode's normalization stability). The
   * other rules read a character's category and `Default_Ignorable_Code_Point`, which Unicode does
   * not promise to keep (#587: U+00AD went from `Pd` to `Cf` in 4.0, U+180E from `Zs` to `Cf` in
   * 6.3): a newer runtime may refuse a key an older one accepted — a refusal, never a second charge.
   */
  Unassigned = "unassigned",
  /** No blank-looking symbol outside the property above (#556): U+2800 BRAILLE PATTERN BLANK. */
  Blank = "blank",
  /**
   * In Unicode normalization form C: "é" as U+00E9, never as "e" + U+0301. Refused, never normalized
   * silently — a key changed on its way in would no longer replay the effect stored under it.
   */
  NotNfc = "not-nfc",
}

/** What each rule asks, as an error says it (the text itself is never named). */
export const KEY_TEXT_RULE_TEXT: Readonly<Record<KeyTextRule, string>> = {
  [KeyTextRule.Length]: `it must be 1 to ${String(MAX_KEY_LENGTH)} characters (UTF-16 code units)`,
  [KeyTextRule.LoneSurrogate]: "it contains a lone surrogate (half of a UTF-16 pair, no character)",
  [KeyTextRule.ControlCharacter]:
    "it contains a control character (C0 U+0000–U+001F, U+007F or C1 U+0080–U+009F)",
  [KeyTextRule.FormatCharacter]:
    "it contains a format character (Unicode Cf: zero-width space or joiner, a bidi control, U+FEFF, a soft hyphen, …)",
  [KeyTextRule.SpaceSeparator]:
    "it contains a space other than U+0020 (Unicode Zs: a no-break, thin or ideographic space, …) or a line or paragraph separator (U+2028, U+2029)",
  [KeyTextRule.Spacing]:
    "it starts or ends with a space (U+0020), or has two in a row: a key's spaces are single and inside",
  [KeyTextRule.Ignorable]:
    "it contains a character that renders as nothing (Unicode Default_Ignorable_Code_Point: a variation selector, a Hangul filler, the combining grapheme joiner, …)",
  [KeyTextRule.PrivateOrNoncharacter]:
    "it contains a private-use character (Unicode Co) or a noncharacter (U+FDD0–U+FDEF, U+xFFFE, U+xFFFF)",
  [KeyTextRule.Unassigned]:
    "it contains a code point unassigned in this runtime's Unicode (Cn): a later version may give it another meaning",
  [KeyTextRule.Blank]: "it contains a blank-looking symbol (U+2800 BRAILLE PATTERN BLANK)",
  [KeyTextRule.NotNfc]:
    'it is not in Unicode normalization form C (NFC): normalize it with text.normalize("NFC") where it is made',
};

/** Whether `text` breaks one rule; the length aside. */
type Breach = (text: string) => boolean;

const matching =
  (pattern: RegExp): Breach =>
  (text) =>
    pattern.test(text);

/** Each rule but the length, in `KeyTextRule`'s order: the first one broken is named. */
const BREACHES: readonly (readonly [KeyTextRule, Breach])[] = [
  [KeyTextRule.LoneSurrogate, matching(/\p{Cs}/u)],
  [KeyTextRule.ControlCharacter, matching(/\p{Cc}/u)],
  [KeyTextRule.FormatCharacter, matching(/\p{Cf}/u)],
  // every space separator but U+0020, and the line and paragraph separators (#547)
  [KeyTextRule.SpaceSeparator, matching(/(?! )[\p{Zs}\p{Zl}\p{Zp}]/u)],
  // a space at an edge, or two in a row
  [KeyTextRule.Spacing, matching(/^ | $| {2}/u)],
  [KeyTextRule.Ignorable, matching(/\p{Default_Ignorable_Code_Point}/u)],
  // noncharacters are Cn too: named before the unassigned ones
  [KeyTextRule.PrivateOrNoncharacter, matching(/[\p{Co}\p{Noncharacter_Code_Point}]/u)],
  [KeyTextRule.Unassigned, matching(/\p{Cn}/u)],
  [KeyTextRule.Blank, matching(/⠀/u)],
  [KeyTextRule.NotNfc, (text) => text.normalize("NFC") !== text],
];

/**
 * The first rule of a key's text (#538, #547, #556) that `text` breaks, in `KeyTextRule`'s order;
 * `undefined` when it is a key.
 */
export function keyTextRuleOf(text: string): KeyTextRule | undefined {
  if (text.length === 0 || text.length > MAX_KEY_LENGTH) return KeyTextRule.Length;
  return BREACHES.find(([, breaks]) => breaks(text))?.[0];
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
