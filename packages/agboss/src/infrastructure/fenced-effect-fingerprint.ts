import { currentFrame } from "../flow/context/frame.js";
import { keyedDigestOf } from "../pii/tokens.js";
import { NonJsonValueError, stableJson } from "../turns/index.js";
import {
  fingerprintNotJson,
  fingerprintRequired,
  FingerprintProblem,
  secretKeyMissing,
} from "./idempotency-errors.js";
import type { IdempotencyError } from "../core/error-families/effect-errors.js";
import type { EffectKeyFields } from "./effect-key.js";
import type { JsonValue } from "./fenced-effect.repository.js";

/**
 * What a business key says it does (#508, #825): its fingerprint — an HMAC of canonical JSON under
 * the application's idempotency key, and the previous key's during a rotation —, the explicit
 * opt-out `FingerprintPolicy.None`, or neither for a call that leaves the system. Never an unkeyed
 * digest; a fenced effect under a business key that says neither is refused.
 */
/** A business identity for a fenced effect's or a call's key (#508). */
export interface BusinessKeyOptions {
  /**
   * `"order:42"`: a key's text (#538, `KeyTextRule`) — 1–200 characters, no control or format
   * character, no lone surrogate, in NFC. Never sent to a model.
   */
  readonly businessKey: string;
}

/**
 * A business key with what the effect does (#508, #825): plain JSON, digested under the
 * application's idempotency key — another value under the same business key is
 * `IdempotencyError.KeyConflict`, never a replay.
 */
export interface FingerprintedKeyOptions<TFingerprint> extends BusinessKeyOptions {
  readonly fingerprint: JsonValue<TFingerprint>;
  readonly withoutFingerprint?: never;
}

/** A business key without a fingerprint, on purpose (#825): `withoutFingerprint: true`. */
export interface UnfingerprintedKeyOptions extends BusinessKeyOptions {
  readonly withoutFingerprint: true;
  readonly fingerprint?: never;
}

/**
 * A business key whose fingerprint is its call's request (#825): an `OutboundCallKey`, which only
 * `OutboundCalls.send` takes — a fenced effect under it does not compile.
 */
export interface OutboundCallKeyOptions extends BusinessKeyOptions {
  readonly fingerprint?: never;
  readonly withoutFingerprint?: never;
}

/** A business identity for a key (#508, #825): with a fingerprint, without one on purpose, or a call's. */
export type EffectKeyOptions<TFingerprint = unknown> =
  FingerprintedKeyOptions<TFingerprint> | UnfingerprintedKeyOptions | OutboundCallKeyOptions;

/** The label the fingerprint's subkey is derived under (#508): `HMAC(idempotencyKey, label)`. */
export const FINGERPRINT_LABEL = "agboss/fingerprint/v1";

/** The idempotency keys a step's fingerprints are made under (#825): the current, the previous. */
export interface FingerprintKeys {
  /** `@Application({ idempotencyKeyField })`'s value: what every fingerprint is stored under. */
  readonly current: string;
  /** `previousIdempotencyKeyField`'s value during a rotation: what older rows are matched by. */
  readonly previous?: string | undefined;
}

/** A value's fingerprints (#825): under the current idempotency key, and the previous one's. */
export interface KeyFingerprints {
  readonly fingerprint: string;
  readonly previousFingerprint?: string;
}

/** A fingerprint of `text` under one idempotency key: `HMAC(HMAC(key, label), text)`. */
const digestUnder = (key: string, text: string): string =>
  keyedDigestOf(keyedDigestOf(key, FINGERPRINT_LABEL), text);

/**
 * The fingerprints of `value` (#508, #825): an HMAC-SHA256 of its canonical JSON under a subkey of the
 * application's idempotency key — the same in every execution and on every instance, so a business
 * key's calls compare across them, and no guessable request can be found from a stored one — and,
 * during a rotation, the same under the previous key (`previousFingerprint`, matched, never stored).
 * No key in the step (no `idempotencyKeyField`, or outside a step) → `IdempotencyError.SecretKeyMissing`:
 * never an unkeyed digest.
 */
export function fingerprintsOf(value: unknown, name: string): KeyFingerprints {
  const keys = currentFrame()?.execution.fingerprintKeys;
  if (keys === undefined) throw secretKeyMissing({ effect: name });
  try {
    return fingerprintsUnder(keys, value);
  } catch (error) {
    // #825: named by its effect — a DTO instance or a Date is no fingerprint
    if (error instanceof NonJsonValueError)
      throw fingerprintNotJson({ effect: name, path: error.path, reason: error.reason });
    throw error;
  }
}

/** The fingerprints of `value` under `keys` (#825): the current one's, and the previous one's. */
export function fingerprintsUnder(keys: FingerprintKeys, value: unknown): KeyFingerprints {
  const text = `fingerprint\u0000${stableJson(value)}`;
  const fingerprint = digestUnder(keys.current, text);
  return keys.previous === undefined
    ? { fingerprint }
    : { fingerprint, previousFingerprint: digestUnder(keys.previous, text) };
}

/**
 * Whether a stored fingerprint is `key`'s (#508, #825): the current one — a `null` and a missing one
 * are the same, none; `""` is a fingerprint (#574) — or, during a rotation, the previous key's.
 */
export function isKeyFingerprint(
  key: Pick<EffectKeyFields, "fingerprint" | "previousFingerprint">,
  stored: string | null | undefined,
): boolean {
  const found = stored ?? undefined;
  if (found === key.fingerprint) return true;
  // a previous key's match only for a stored one (`found` none is no previous key's fingerprint)
  return key.previousFingerprint !== undefined && found === key.previousFingerprint;
}

/**
 * What a business key's options say it does (#825), read once: its fingerprints, `withoutFingerprint:
 * true`, or nothing (a call's key). Both — or a `withoutFingerprint` that is not `true` — is
 * `IdempotencyError.FingerprintRequired`.
 */
export function fingerprintFactsOf(
  name: string,
  options: EffectKeyOptions,
): Pick<EffectKeyFields, "fingerprint" | "previousFingerprint" | "withoutFingerprint"> {
  const { fingerprint, withoutFingerprint } = options as {
    readonly fingerprint?: unknown;
    readonly withoutFingerprint?: unknown;
  };
  if (withoutFingerprint === undefined)
    return fingerprint === undefined ? {} : fingerprintsOf(fingerprint, name);
  if (withoutFingerprint !== true || fingerprint !== undefined)
    throw fingerprintRequired({ effect: name, reason: FingerprintProblem.Contradictory });
  return { withoutFingerprint: true };
}

/**
 * The `IdempotencyError.FingerprintRequired` of a key an effect is given (#825), `undefined` when it
 * has a fingerprint, says `withoutFingerprint: true`, or has no business key. Checked at the store's
 * entry, before any transaction (exported for stores outside the core: as the core's stores check it).
 */
export function fingerprintErrorOf(
  key: Pick<EffectKeyFields, "name" | "businessKey" | "fingerprint" | "withoutFingerprint">,
): IdempotencyError.FingerprintRequired | undefined {
  if (key.businessKey === undefined) return undefined;
  const { name, fingerprint } = key;
  // as a JavaScript caller or a cast may hand it over: any value
  const withoutFingerprint: unknown = key.withoutFingerprint;
  if (withoutFingerprint === undefined)
    return fingerprint === undefined
      ? fingerprintRequired({ effect: name, reason: FingerprintProblem.Missing })
      : undefined;
  return withoutFingerprint === true && fingerprint === undefined
    ? undefined
    : fingerprintRequired({ effect: name, reason: FingerprintProblem.Contradictory });
}

/** Throws `fingerprintErrorOf(key)` (#825): a business key without its fingerprint decision. */
export function assertFingerprintDecided(key: Parameters<typeof fingerprintErrorOf>[0]): void {
  const problem = fingerprintErrorOf(key);
  if (problem !== undefined) throw problem;
}
