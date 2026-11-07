import { AGBossError, KEY_TEXT_RULE_TEXT, type KeyTextRule } from "../core/errors.js";

/**
 * The errors of a fenced effect's or a call's key (#508, #538): a name that is not one, a business
 * key that is not one, the same business key with another fingerprint — none names the key itself.
 */

/**
 * An effect's or a call's name that is not one (#508): it must be 1–100 letters, digits, `.`, `_` or
 * `-`, starting with a letter or a digit — it is part of the keys sent to other systems.
 */
export class InvalidFencedEffectNameError extends AGBossError {
  static override readonly code: string = "fenced-effect.invalid-name";
  override name = "InvalidFencedEffectNameError";

  constructor(length: number) {
    super(
      `a fenced effect's name (${String(length)} characters) must be 1–100 letters, digits, ".", "_" or "-", starting with a letter or a digit`,
    );
  }
}

/** What an invalid business key knows: the effect, and the rule it breaks — never the key itself. */
export interface InvalidBusinessKeyErrorOptions {
  readonly name: string;
  readonly rule: KeyTextRule;
}

/**
 * A business key that is not one (#508, #538): it breaks a rule of a key's text (`rule`) — the
 * rule of thread ids. Nothing ran; the message names the rule, never the key (it may carry an id).
 */
export class InvalidBusinessKeyError extends AGBossError {
  static override readonly code: string = "fenced-effect.invalid-business-key";
  override name = "InvalidBusinessKeyError";
  readonly effect: string;
  readonly rule: KeyTextRule;

  constructor(options: InvalidBusinessKeyErrorOptions) {
    super(
      `the business key of "${options.name}" is not one (${options.rule}): ${KEY_TEXT_RULE_TEXT[options.rule]}`,
      { details: { effect: options.name, rule: options.rule } },
    );
    this.effect = options.name;
    this.rule = options.rule;
  }
}

/** What a conflict knows: the effect and the business key's handle — never the key. */
export interface IdempotencyKeyConflictErrorOptions {
  readonly name: string;
  readonly businessKeyHash?: string | undefined;
}

/**
 * The same business key with another fingerprint (#508): `order:42` charged $10, then $12. Never
 * replayed, nothing ran or was sent — a bug or a tampered request, for a person to look at. Neither
 * the key nor any value is in the error (a business key carries ids): `businessKeyHash` correlates
 * it with the caller's own log.
 */
export class IdempotencyKeyConflictError extends AGBossError {
  static override readonly code: string = "fenced-effect.key-conflict";
  override name = "IdempotencyKeyConflictError";
  readonly effect: string;
  /** The business key's handle, when one could be made (`EffectKey.businessKeyHash`). */
  declare readonly businessKeyHash?: string;

  constructor(options: IdempotencyKeyConflictErrorOptions) {
    const { name, businessKeyHash } = options;
    const handle = businessKeyHash === undefined ? "" : ` (handle ${businessKeyHash})`;
    super(
      `"${name}" was already made under the same business key${handle} with other parameters: refused, nothing ran`,
    );
    this.effect = name;
    // absent, not undefined, when no handle could be made
    if (businessKeyHash !== undefined) this.businessKeyHash = businessKeyHash;
  }
}

/**
 * A business key's fingerprint that is not plain JSON (#825): a DTO instance, a `Date`, a function —
 * what canonical JSON cannot say once and the same everywhere. Names the effect and where in the
 * value, never the value.
 */
export class FingerprintNotJsonError extends AGBossError {
  static override readonly code: string = "fenced-effect.fingerprint-not-json";
  override name = "FingerprintNotJsonError";
  readonly effect: string;
  readonly path: string;

  constructor(effect: string, problem: { readonly path: string; readonly reason: string }) {
    super(
      `the fingerprint of "${effect}" is not plain JSON at ${problem.path}: ${problem.reason} — fingerprint: { …the plain fields of what the work does }, never a DTO instance, a Date or a function`,
      { details: { effect, path: problem.path } },
    );
    this.effect = effect;
    this.path = problem.path;
  }
}
