import { AGBossError, KEY_TEXT_RULE_TEXT, type KeyTextRule } from "../core/errors.js";

/**
 * The errors of a fenced effect's or a call's key (#508, #538): a name that is not one, a business
 * key that is not one, the same business key with another fingerprint — none names the key itself.
 */

/** What an invalid name knows: how long it is — never the name. */
export interface InvalidFencedEffectNameErrorOptions {
  /** How many characters the name has. */
  readonly length: number;
  readonly cause?: unknown;
}

/**
 * An effect's or a call's name that is not one (#508): it must be 1–100 letters, digits, `.`, `_` or
 * `-`, starting with a letter or a digit — it is part of the keys sent to other systems.
 */
export class InvalidFencedEffectNameError extends AGBossError {
  static override readonly code = "fenced-effect.invalid-name" as const;
  declare readonly code: typeof InvalidFencedEffectNameError.code;
  override name = "InvalidFencedEffectNameError";
  /** How many characters the name has (never the name itself). */
  readonly length: number;

  constructor(options: InvalidFencedEffectNameErrorOptions) {
    const { length, cause } = options;
    super(
      `a fenced effect's name (${String(length)} characters) must be 1–100 letters, digits, ".", "_" or "-", starting with a letter or a digit`,
      { cause },
    );
    this.length = length;
  }
}

/** What an invalid business key knows: the effect, and the rule it breaks — never the key itself. */
export interface InvalidBusinessKeyErrorOptions {
  /** The effect's or the call's name. */
  readonly effect: string;
  readonly rule: KeyTextRule;
  readonly cause?: unknown;
}

/**
 * A business key that is not one (#508, #538): it breaks a rule of a key's text (`rule`) — the
 * rule of thread ids. Nothing ran; the message names the rule, never the key (it may carry an id).
 */
export class InvalidBusinessKeyError extends AGBossError {
  static override readonly code = "fenced-effect.invalid-business-key" as const;
  declare readonly code: typeof InvalidBusinessKeyError.code;
  override name = "InvalidBusinessKeyError";
  readonly effect: string;
  readonly rule: KeyTextRule;

  constructor(options: InvalidBusinessKeyErrorOptions) {
    const { effect, rule, cause } = options;
    super(`the business key of "${effect}" is not one (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`, {
      cause,
      details: { effect, rule },
    });
    this.effect = effect;
    this.rule = rule;
  }
}

/** What a conflict knows: the effect and the business key's handle — never the key. */
export interface BusinessKeyConflictErrorOptions {
  /** The effect's or the call's name. */
  readonly effect: string;
  readonly businessKeyHash?: string | undefined;
  readonly cause?: unknown;
}

/**
 * The same business key with another fingerprint (#508): `order:42` charged $10, then $12. Never
 * replayed, nothing ran or was sent — a bug or a tampered request, for a person to look at. Neither
 * the key nor any value is in the error (a business key carries ids): `businessKeyHash` correlates
 * it with the caller's own log.
 */
export class BusinessKeyConflictError extends AGBossError {
  static override readonly code = "fenced-effect.business-key-conflict" as const;
  declare readonly code: typeof BusinessKeyConflictError.code;
  override name = "BusinessKeyConflictError";
  readonly effect: string;
  /** The business key's handle, when one could be made (`EffectKey.businessKeyHash`). */
  declare readonly businessKeyHash?: string;

  constructor(options: BusinessKeyConflictErrorOptions) {
    const { effect, businessKeyHash, cause } = options;
    const handle = businessKeyHash === undefined ? "" : ` (handle ${businessKeyHash})`;
    super(
      `"${effect}" was already made under the same business key${handle} with other parameters: refused, nothing ran`,
      { cause },
    );
    this.effect = effect;
    // absent, not undefined, when no handle could be made
    if (businessKeyHash !== undefined) this.businessKeyHash = businessKeyHash;
  }
}

/** What a fingerprint that is not plain JSON knows: the effect, where, and what is there. */
export interface FingerprintNotJsonErrorOptions {
  readonly effect: string;
  readonly path: string;
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * A business key's fingerprint that is not plain JSON (#825): a DTO instance, a `Date`, a function —
 * what canonical JSON cannot say once and the same everywhere. Names the effect and where in the
 * value, never the value.
 */
export class FingerprintNotJsonError extends AGBossError {
  static override readonly code = "fenced-effect.fingerprint-not-json" as const;
  declare readonly code: typeof FingerprintNotJsonError.code;
  override name = "FingerprintNotJsonError";
  readonly effect: string;
  /** Where in the fingerprint (`$.order.placedAt`). */
  readonly path: string;
  /** What is there instead of plain JSON (`a Date`), never its value. */
  readonly reason: string;

  constructor(options: FingerprintNotJsonErrorOptions) {
    const { effect, path, reason, cause } = options;
    super(
      `the fingerprint of "${effect}" is not plain JSON at ${path}: ${reason} — fingerprint: { …the plain fields of what the work does }, never a DTO instance, a Date or a function`,
      { cause, details: { effect, path } },
    );
    this.effect = effect;
    this.path = path;
    this.reason = reason;
  }
}

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
