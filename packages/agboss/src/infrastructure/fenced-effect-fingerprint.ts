import { AGBossError } from "../core/errors.js";
import { currentFrame } from "../flow/context/frame.js";
import { keyedDigestOf } from "../pii/tokens.js";
import { NonJsonValueError, stableJson } from "../turns/index.js";
import { FingerprintNotJsonError } from "./fenced-effect-errors.js";
import type { EffectKeyFields } from "./effect-key.js";
import type { JsonValue } from "./fenced-effect.repository.js";

/**
 * What a business key says it does (#508, #825): its fingerprint — an HMAC of canonical JSON under
 * the application's idempotency key, and the previous key's during a rotation —, the explicit
 * opt-out `FingerprintPolicy.None`, or neither for a call that leaves the system. Never an unkeyed
 * digest; a fenced effect under a business key that says neither is refused.
 */
/** How a business key goes without a fingerprint (#825). */
export enum FingerprintPolicy {
  /**
   * No fingerprint, on purpose: every call under the business key replays the first, whatever its
   * work — for work the business key fixes by itself (an event applied once by its id), never as a
   * shortcut for one whose parameters can differ.
   */
  None = "none",
}

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
 * `BusinessKeyConflictError`, never a replay.
 */
export interface FingerprintedKeyOptions<TFingerprint> extends BusinessKeyOptions {
  readonly fingerprint: JsonValue<TFingerprint>;
  readonly fingerprintPolicy?: never;
}

/** A business key without a fingerprint, on purpose (#825): `FingerprintPolicy.None`. */
export interface UnfingerprintedKeyOptions extends BusinessKeyOptions {
  readonly fingerprintPolicy: FingerprintPolicy.None;
  readonly fingerprint?: never;
}

/**
 * A business key whose fingerprint is its call's request (#825): an `OutboundCallKey`, which only
 * `OutboundCalls.send` takes — a fenced effect under it does not compile.
 */
export interface OutboundCallKeyOptions extends BusinessKeyOptions {
  readonly fingerprint?: never;
  readonly fingerprintPolicy?: never;
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
 * No key in the step (no `idempotencyKeyField`, or outside a step) → `IdempotencyKeyMissingError`:
 * never an unkeyed digest.
 */
export function fingerprintsOf(value: unknown, name: string): KeyFingerprints {
  const keys = currentFrame()?.execution.fingerprintKeys;
  if (keys === undefined) throw new IdempotencyKeyMissingError({ effect: name });
  try {
    return fingerprintsUnder(keys, value);
  } catch (error) {
    // #825: named by its effect — a DTO instance or a Date is no fingerprint
    if (error instanceof NonJsonValueError)
      throw new FingerprintNotJsonError({ effect: name, path: error.path, reason: error.reason });
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
 * What a business key's options say it does (#825), read once: its fingerprints, the policy
 * `None`, or nothing (a call's key). Both — or a policy that is not one — is `FingerprintRequiredError`.
 */
export function fingerprintFactsOf(
  name: string,
  options: EffectKeyOptions,
): Pick<EffectKeyFields, "fingerprint" | "previousFingerprint" | "fingerprintPolicy"> {
  const { fingerprint, fingerprintPolicy } = options as {
    readonly fingerprint?: unknown;
    readonly fingerprintPolicy?: unknown;
  };
  if (fingerprintPolicy === undefined)
    return fingerprint === undefined ? {} : fingerprintsOf(fingerprint, name);
  if (fingerprintPolicy !== FingerprintPolicy.None || fingerprint !== undefined)
    throw new FingerprintRequiredError({ effect: name, reason: FingerprintProblem.Contradictory });
  return { fingerprintPolicy: FingerprintPolicy.None };
}

/** Why a key cannot be a fenced effect's (#825). */
export enum FingerprintProblem {
  /** A business key with neither a fingerprint nor `FingerprintPolicy.None`. */
  Missing = "missing",
  /** Both, or a policy that is not `FingerprintPolicy.None`. */
  Contradictory = "contradictory",
}

/** What a fingerprint refusal knows: the effect and why — never the key. */
export interface FingerprintRequiredErrorOptions {
  /** The effect's or the call's name (#906: its key is the field's, as on the other fenced-effect errors). */
  readonly effect: string;
  readonly reason: FingerprintProblem;
  readonly cause?: unknown;
}

/**
 * A fenced effect under a business key that does not say what it does (#825): no `fingerprint` and
 * no `fingerprintPolicy: FingerprintPolicy.None` — two calls with other work would replay each
 * other — or both at once. Nothing ran; a compile error for TypeScript, this for a JavaScript
 * caller or a key built by hand.
 */
export class FingerprintRequiredError extends AGBossError {
  static override readonly code = "fenced-effect.fingerprint-required" as const;
  declare readonly code: typeof FingerprintRequiredError.code;
  override name = "FingerprintRequiredError";
  readonly effect: string;
  readonly reason: FingerprintProblem;

  constructor(options: FingerprintRequiredErrorOptions) {
    const why =
      options.reason === FingerprintProblem.Missing
        ? "names neither a fingerprint nor fingerprintPolicy: FingerprintPolicy.None"
        : "names a fingerprint and a fingerprintPolicy, or a policy that is not FingerprintPolicy.None";
    super(
      `the fenced effect "${options.effect}" under a business key ${why} — effectKeyOf(executionContext, name, { businessKey, fingerprint: { …what the work does } }): nothing ran`,
      { cause: options.cause, details: { effect: options.effect, reason: options.reason } },
    );
    this.effect = options.effect;
    this.reason = options.reason;
  }
}

/**
 * The `FingerprintRequiredError` of a key a fenced effect is given (#825), `undefined` when it has a
 * fingerprint, says `FingerprintPolicy.None`, or has no business key. Checked at the store's entry,
 * before any transaction (exported for stores outside the core: as the core's stores check it).
 */
export function fingerprintErrorOf(
  key: Pick<EffectKeyFields, "name" | "businessKey" | "fingerprint" | "fingerprintPolicy">,
): FingerprintRequiredError | undefined {
  if (key.businessKey === undefined) return undefined;
  const { name, fingerprint } = key;
  // as a JavaScript caller or a cast may hand it over: any value
  const fingerprintPolicy: unknown = key.fingerprintPolicy;
  if (fingerprintPolicy === undefined)
    return fingerprint === undefined
      ? new FingerprintRequiredError({ effect: name, reason: FingerprintProblem.Missing })
      : undefined;
  return fingerprintPolicy === FingerprintPolicy.None && fingerprint === undefined
    ? undefined
    : new FingerprintRequiredError({ effect: name, reason: FingerprintProblem.Contradictory });
}

/** What a missing idempotency key knows: the effect (or call) whose fingerprint needed it. */
export interface IdempotencyKeyMissingErrorOptions {
  readonly effect: string;
  readonly cause?: unknown;
}

/**
 * A business key's fingerprint made with no idempotency key (#825): the application names no
 * `idempotencyKeyField` (`[application.idempotency-key-required]` at assembly when its components
 * reach `OutboundCalls` or a fenced-effect store), or the key is made outside a step. Never an
 * unkeyed digest: a stored fingerprint of a low-entropy request would give the request away.
 */
export class IdempotencyKeyMissingError extends AGBossError {
  static override readonly code = "fenced-effect.idempotency-key-missing" as const;
  declare readonly code: typeof IdempotencyKeyMissingError.code;
  override name = "IdempotencyKeyMissingError";
  readonly effect: string;

  constructor(options: IdempotencyKeyMissingErrorOptions) {
    const { effect, cause } = options;
    super(
      `"${effect}" is under a business key, whose fingerprint is keyed by the application's idempotency key — none here: name a Secret field in @Application({ idempotencyKeyField }) and make the key in a step`,
      { cause, details: { effect } },
    );
    this.effect = effect;
  }
}

/** Throws `fingerprintErrorOf(key)` (#825): a business key without its fingerprint decision. */
export function assertFingerprintDecided(key: Parameters<typeof fingerprintErrorOf>[0]): void {
  const problem = fingerprintErrorOf(key);
  if (problem !== undefined) throw problem;
}
