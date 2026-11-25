import { IdempotencyError } from "../core/error-families/effect-errors.js";
import { KEY_TEXT_RULE_TEXT, type KeyTextRule } from "../core/errors.js";
import type { Bytes } from "../units/index.js";

/**
 * The errors of `Idempotency` and its stores (#1317, #1325): each one `IdempotencyError.<Variant>`,
 * made here with its own sentence — never the key, the fingerprint or a value, only the effect's
 * name, a handle and the rule broken. The stores outside the core build the same through
 * `IdempotencyError` itself.
 */

/** A name that is not one (#508): it must be 1–100 letters, digits, `.`, `_` or `-`, starting with a letter or a digit. */
export const invalidEffectName = (length: number): IdempotencyError.InvalidName =>
  new IdempotencyError.InvalidName({
    message: `an idempotent effect's name (${String(length)} characters) must be 1–100 letters, digits, ".", "_" or "-", starting with a letter or a digit`,
    length,
  });

/** What an invalid business key knows: the effect, and the rule it breaks — never the key itself. */
export interface InvalidBusinessKeyOptions {
  /** The effect's or the call's name. */
  readonly effect: string;
  readonly rule: KeyTextRule;
  readonly cause?: unknown;
}

/** A business key that is not one (#508, #538): it breaks a rule of a key's text; the message names the rule, never the key. */
export const invalidBusinessKey = (
  options: InvalidBusinessKeyOptions,
): IdempotencyError.InvalidKey => {
  const { effect, rule, cause } = options;
  return new IdempotencyError.InvalidKey({
    message: `the key of "${effect}" is not one (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`,
    effect,
    rule,
    cause,
  });
};

/** A `shortKey(length)` whose length is not a whole number from 16 to 43 (#1317d): never a bare `RangeError`. */
export const invalidShortKeyLength = (length: unknown): IdempotencyError.InvalidKey =>
  new IdempotencyError.InvalidKey({
    message: `call.shortKey(length) takes a whole number of characters from 16 to 43 (a shorter prefix of an HMAC is not unique enough), not ${typeof length === "number" ? String(length) : typeof length}`,
  });

/** A key a store or `Idempotency` was given that no key-maker made (#825): a copy, a hand-built object. */
export const unissuedKey = (message: string): IdempotencyError.InvalidKey =>
  new IdempotencyError.InvalidKey({ message });

/** What a conflict knows: the effect and the business key's handle — never the key. */
export interface BusinessKeyConflictOptions {
  readonly effect: string;
  readonly businessKeyHash?: string | undefined;
  readonly cause?: unknown;
}

/**
 * The same business key with another fingerprint (#508): `order:42` charged $10, then $12. Never
 * replayed, nothing ran or was sent. `businessKeyHash` correlates it with the caller's own log.
 */
export function businessKeyConflict(
  options: BusinessKeyConflictOptions,
): IdempotencyError.KeyConflict {
  const { effect, businessKeyHash, cause } = options;
  const handle = businessKeyHash === undefined ? "" : ` (handle ${businessKeyHash})`;
  return new IdempotencyError.KeyConflict({
    message: `"${effect}" was already made under the same key${handle} with other parameters: refused, nothing ran`,
    effect,
    // absent, not undefined, when no handle could be made
    ...(businessKeyHash === undefined ? {} : { businessKeyHash }),
    cause,
  });
}

/** What a fingerprint that is not plain JSON knows: the effect, where, and what is there. */
export interface FingerprintNotJsonOptions {
  readonly effect: string;
  readonly path: string;
  readonly reason: string;
  readonly cause?: unknown;
}

/** A fingerprint that is not plain JSON (#825): names the effect and where in the value, never the value. */
export const fingerprintNotJson = (
  options: FingerprintNotJsonOptions,
): IdempotencyError.FingerprintNotJson => {
  const { effect, path, reason, cause } = options;
  return new IdempotencyError.FingerprintNotJson({
    message: `the fingerprint of "${effect}" is not plain JSON at ${path}: ${reason} — fingerprint: { …the plain fields of what the work does }, never a DTO instance, a Date or a function`,
    effect,
    path,
    reason,
    cause,
  });
};

/** Why a key cannot be an effect's (#825). */
export enum FingerprintProblem {
  /** A key with neither a fingerprint nor `withoutFingerprint: true`. */
  Missing = "missing",
  /** Both. */
  Contradictory = "contradictory",
}

/** What a fingerprint refusal knows: the effect and why — never the key. */
export interface FingerprintRequiredOptions {
  readonly effect: string;
  readonly reason: FingerprintProblem;
  readonly cause?: unknown;
}

/**
 * An effect under a key that does not say what it does (#825): no `fingerprint` and no
 * `withoutFingerprint: true` — two calls with other work would replay each other — or both.
 */
export const fingerprintRequired = (
  options: FingerprintRequiredOptions,
): IdempotencyError.FingerprintRequired => {
  const why =
    options.reason === FingerprintProblem.Missing
      ? "names neither a fingerprint nor withoutFingerprint: true"
      : "names a fingerprint and withoutFingerprint: true, or a withoutFingerprint that is not true";
  return new IdempotencyError.FingerprintRequired({
    message: `the effect "${options.effect}" under a key ${why} — idempotency.runOnce({ name, key, fingerprint: { …what the work does }, … }): nothing ran`,
    effect: options.effect,
    reason: options.reason,
    cause: options.cause,
  });
};

/** What a missing idempotency secret knows: the effect (or call) whose fingerprint needed it. */
export interface SecretKeyMissingOptions {
  readonly effect: string;
  readonly cause?: unknown;
}

/**
 * A key's fingerprint made with no idempotency secret (#825): the application's `@DatabaseStorage`
 * names no `idempotencySecret` (`[application.idempotency-key-required]` at assembly when its
 * components reach `Idempotency`), or the key is made outside a step. Never an unkeyed digest: a
 * stored fingerprint of a low-entropy request would give the request away.
 */
export const secretKeyMissing = (
  options: SecretKeyMissingOptions,
): IdempotencyError.SecretKeyMissing =>
  new IdempotencyError.SecretKeyMissing({
    message: `"${options.effect}" is under a key, whose fingerprint is keyed by the application's idempotency secret — none here: name idempotencySecret in @DatabaseStorage and make the key in a step`,
    effect: options.effect,
    cause: options.cause,
  });

/** What a result too large to store knows: the effect, its size and the limit (UTF-8 bytes). */
export interface ResultTooLargeOptions {
  readonly effect: string;
  readonly size: Bytes;
  readonly maxResultSize: Bytes;
  readonly cause?: unknown;
}

/**
 * An effect's result is larger than its `maxResultSize` (#500, default 64 KB): its transaction is
 * rolled back — the business rows too — and the step fails with it. Store a reference, not the document.
 */
export const resultTooLarge = (options: ResultTooLargeOptions): IdempotencyError.ResultTooLarge =>
  new IdempotencyError.ResultTooLarge({
    message: `the result of idempotent effect "${options.effect}" is ${String(options.size)} bytes, above its maxResultSize of ${String(options.maxResultSize)} bytes: nothing was written — store a reference to it, or raise maxResultSize of runOnce`,
    effect: options.effect,
    size: options.size,
    maxResultSize: options.maxResultSize,
    cause: options.cause,
  });

/** Which stores do not match: the effect store and the lease store the application uses. */
export interface StoreMismatchOptions {
  readonly fencedEffectRepository: string;
  readonly leaseRepository: string;
  /** The lease store the effect store reads its leases from. */
  readonly expectedLeaseRepository: string;
  readonly cause?: unknown;
}

/**
 * The effect store reads the leases of another store than the application's (#500): the built-in
 * in-memory one used beside a listed `SqliteExecutionLeaseRepository`, say. It would refuse every
 * write, so the first call fails with this instead.
 */
export const storeMismatch = (options: StoreMismatchOptions): IdempotencyError.StoreMismatch =>
  new IdempotencyError.StoreMismatch({
    message: `${options.fencedEffectRepository} checks the leases of ${options.expectedLeaseRepository}, but the application's leases are in ${options.leaseRepository}: list the idempotency store of that lease store's database in @Application({ providers })`,
    fencedEffectRepository: options.fencedEffectRepository,
    leaseRepository: options.leaseRepository,
    expectedLeaseRepository: options.expectedLeaseRepository,
    cause: options.cause,
  });
