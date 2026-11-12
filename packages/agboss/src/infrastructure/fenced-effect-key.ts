import type { ExecutionContext } from "../flow/context/execution-context.js";
import { currentFrame } from "../flow/context/frame.js";
import { keyedDigestOf } from "../pii/tokens.js";
import { issuedKey } from "./issued-keys.js";
import {
  fingerprintFactsOf,
  isKeyFingerprint,
  type EffectKeyOptions,
  type FingerprintedKeyOptions,
  type OutboundCallKeyOptions,
  type UnfingerprintedKeyOptions,
} from "./fenced-effect-fingerprint.js";
import type { OutboundCallIntent, OutboundCallRecord } from "./outbound-call-record.js";
import type { OutboundCallStatus } from "./outbound-call.repository.js";
import { keyTextRuleOf } from "../core/errors.js";
import {
  BusinessKeyConflictError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
} from "./fenced-effect-errors.js";
import type {
  EffectKey,
  EffectKeyFields,
  FencedEffectOrigin,
  OutboundCallKey,
} from "./fenced-effect.repository.js";

/**
 * The key of a fenced effect or of an outbound call (#500, #505), and its business identity
 * (#508): by default one key per step and name; with a business key one per tenant, name and
 * business key — deduplicated across tool calls, visits, executions and threads — with a
 * fingerprint of what the effect does, so the same key with other parameters is a conflict.
 */

/**
 * Checks an effect's name (#508): 1–100 of `[A-Za-z0-9._-]`, else `InvalidFencedEffectNameError` —
 * by `effectKeyOf` and again at every store's entry, for a key built by hand (exported for
 * stores outside the core, #526: before any statement, as the core's stores check it).
 */
export function assertEffectName(name: string): void {
  if (!isEffectName(name)) throw new InvalidFencedEffectNameError({ length: name.length });
}

/**
 * Checks a key's business key (#538): a key's text (`keyTextRuleOf`), else
 * `InvalidBusinessKeyError` naming the rule, never the key — by `effectKeyOf`,
 * `OutboundCalls.send` and again at every store's entry, for a key built by hand (exported for
 * stores outside the core: before any statement, beside `assertEffectName`).
 */
export function assertBusinessKey(key: Pick<EffectKeyFields, "name" | "businessKey">): void {
  const invalid = businessKeyErrorOf(key);
  if (invalid !== undefined) throw invalid;
}

/** The `InvalidBusinessKeyError` of `key`'s business key (#538), `undefined` when it has a valid one or none. */
export function businessKeyErrorOf(
  key: Pick<EffectKeyFields, "name" | "businessKey">,
): InvalidBusinessKeyError | undefined {
  const rule = key.businessKey === undefined ? undefined : keyTextRuleOf(key.businessKey);
  return rule === undefined ? undefined : new InvalidBusinessKeyError({ effect: key.name, rule });
}

/** Whether `name` is an effect's name (#508): 1–100 of `[A-Za-z0-9._-]`, a letter or digit first. */
export const isEffectName = (name: string): boolean => EFFECT_NAME.test(name);

/**
 * The key of the current step's effect `name` (#500): the lease the step runs under
 * (`executionContext.fence`) and its idempotency key (`executionContext.step`) — the same when the
 * step runs again after a crash, a newer token once another instance took the lease over. With a
 * business key (#508) the identity is the tenant, the name and the business key — an invalid one
 * throws `InvalidBusinessKeyError` — and what it does is said (#825): `fingerprint` (digested under
 * the application's idempotency key), `fingerprintPolicy: FingerprintPolicy.None` on purpose, or
 * neither for a call that leaves the system (an `OutboundCallKey`: its request is its fingerprint).
 * Where no lease is held (a reply interpreter, `maxSpend()`, a yielded lease, an ancestor's context)
 * it throws `ExecutionContextUnavailableError`, as `fence` does.
 */
export function effectKeyOf(executionContext: ExecutionContext, name: string): EffectKey;
export function effectKeyOf<TFingerprint>(
  executionContext: ExecutionContext,
  name: string,
  options: FingerprintedKeyOptions<TFingerprint> | UnfingerprintedKeyOptions,
): EffectKey;
export function effectKeyOf(
  executionContext: ExecutionContext,
  name: string,
  options: OutboundCallKeyOptions,
): OutboundCallKey;
export function effectKeyOf<TFingerprint>(
  executionContext: ExecutionContext,
  name: string,
  options?: EffectKeyOptions<TFingerprint>,
): EffectKey | OutboundCallKey;
export function effectKeyOf<TFingerprint>(
  executionContext: ExecutionContext,
  name: string,
  options?: EffectKeyOptions<TFingerprint>,
): EffectKey | OutboundCallKey {
  assertEffectName(name);
  const { fence, step } = executionContext;
  const origin = {
    executionId: executionContext.executionId,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
  };
  const key = {
    scopeKey: fence.scopeKey,
    tenantId: fence.tenantId,
    leaseExecutionId: fence.leaseExecutionId,
    token: fence.token,
    idempotencyKey: step.idempotencyKey,
    name,
    origin: Object.freeze(origin),
  };
  // the one maker of a key for an application (#825): branded here, never by a literal
  if (options === undefined) return issuedKey(key) as EffectKey;
  // a JavaScript caller's options without a business key (#825): never a fingerprint of no identity
  if (typeof (options as { readonly businessKey?: unknown }).businessKey !== "string")
    throw new TypeError(`effectKeyOf("${name}", options): options name no businessKey`);
  assertBusinessKey({ name, businessKey: options.businessKey });
  const said = fingerprintFactsOf(name, options);
  const businessKeyHash = businessKeyHashOf(options.businessKey);
  const handle = businessKeyHash === undefined ? {} : { businessKeyHash };
  return issuedKey({ ...key, businessKey: options.businessKey, ...said, ...handle }) as
    EffectKey | OutboundCallKey;
}

/** An effect's name (#508): letters, digits, `.`, `_`, `-`, 1–100 — never a `:` of the keys it is in. */
const EFFECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * A business key's handle (#508): 12 hex characters of an HMAC-SHA256 of `business-key\0<key>` under
 * a subkey derived from the PII key of the execution running now (its own, #334, else the
 * application's `piiKeyField`) — a business key is guessable (`order:42`), so never a plain hash,
 * and never the key's PII token either. `undefined` where no key is available.
 */
export function businessKeyHashOf(businessKey: string): string | undefined {
  const key = currentFrame()?.execution.correlationKey;
  if (key === undefined) return undefined;
  // a subkey of its own (domain separation): never a PII token of the same text, never an oracle
  const subkey = keyedDigestOf(key, BUSINESS_KEY_HANDLE_LABEL);
  return keyedDigestOf(subkey, `business-key\u0000${businessKey}`).slice(0, 12);
}

/**
 * The label the handle's subkey is derived under (#508): `HMAC(piiKey, label)`. Every use of the PII
 * key other than its tokens derives a subkey under a label of its own.
 */
export const BUSINESS_KEY_HANDLE_LABEL = "agboss/business-key-handle/v1";

/**
 * Where a key's row is found (#508): by its step — the scope, the step's idempotency key, the
 * name — or, with a business key, by the tenant, the name and the business key. One text, the
 * parts joined by NUL (exported for stores outside the core, #526: a key-value store's row key).
 */
export const effectKeyIdentityOf = (key: EffectKey): string =>
  key.businessKey === undefined
    ? [key.scopeKey, key.idempotencyKey, key.name].join("\u0000")
    : ["business", key.tenantId, key.name, key.businessKey].join("\u0000");

/**
 * What a stored row keeps of the key that wrote it (#508): its fingerprint and its step. A store
 * hands back what it read — `null` for a column with nothing in it, the step as parsed JSON:
 * `replayedFromOf` checks it, a row is never trusted.
 */
export interface StoredKeyFacts {
  readonly fingerprint?: string | null | undefined;
  readonly origin?: unknown;
}

/**
 * The facts of `key` a row keeps (#508, exported for stores outside the core, #526): its
 * fingerprint and its step, when it has them — stored with the row, read back for `replayedFromOf`.
 */
export const storedKeyFactsOf = (
  key: EffectKey,
): { readonly fingerprint?: string; readonly origin?: FencedEffectOrigin } => ({
  ...(key.fingerprint === undefined ? {} : { fingerprint: key.fingerprint }),
  ...(key.origin === undefined ? {} : { origin: key.origin }),
});

const sameOrigin = (left: FencedEffectOrigin, right: FencedEffectOrigin | undefined): boolean =>
  left.executionId === right?.executionId &&
  left.nodeId === right.nodeId &&
  left.visitNumber === right.visitNumber;

/** A stored step, checked: `undefined` for none, a `TypeError` for a value that is not one. */
function storedOriginOf(value: unknown): FencedEffectOrigin | undefined {
  if (value === undefined || value === null) return undefined;
  const origin = value as Partial<Record<keyof FencedEffectOrigin, unknown>>;
  if (
    typeof origin.executionId === "string" &&
    typeof origin.nodeId === "string" &&
    Number.isInteger(origin.visitNumber)
  )
    return value as FencedEffectOrigin;
  throw new TypeError(
    "a stored fenced-effect row's origin is not a step ({ executionId, nodeId, visitNumber })",
  );
}

/**
 * The replay rule of a row found for `key` (#508, exported for stores outside the core, #526):
 * under a business key, another fingerprint — a `null` and a missing one are the same, none; `""`
 * is a fingerprint, not none (#574); during a rotation the previous key's is the same one (#825) — is
 * `BusinessKeyConflictError` (never a replay, the key not named); a row another step or
 * execution wrote is named as `replayedFrom`. `undefined` for a step's own key, a row of the key's
 * own step, or one without its step.
 */
export function replayedFromOf(
  key: EffectKey,
  stored: StoredKeyFacts,
): FencedEffectOrigin | undefined {
  if (key.businessKey === undefined) return undefined;
  // #825: under the current idempotency key, or the previous one during a rotation
  if (!isKeyFingerprint(key, stored.fingerprint))
    throw new BusinessKeyConflictError({ effect: key.name, businessKeyHash: key.businessKeyHash });
  const origin = storedOriginOf(stored.origin);
  return origin === undefined || sameOrigin(origin, key.origin) ? undefined : origin;
}

/** A key's business identity as a record keeps it (#508): none for a step's key. */
const businessFactsOf = (
  key: EffectKey,
): Pick<OutboundCallRecord, "businessKey" | "fingerprint" | "businessKeyHash"> => ({
  ...(key.businessKey === undefined ? {} : { businessKey: key.businessKey }),
  ...(key.fingerprint === undefined ? {} : { fingerprint: key.fingerprint }),
  ...(key.businessKeyHash === undefined ? {} : { businessKeyHash: key.businessKeyHash }),
});

/**
 * The record `saveIfAbsent` keeps for `key`'s intent (#505, exported for stores outside the core,
 * #526): the intent as given, `Pending` under the key's lease and token, its business identity
 * (#508) and when it was recorded (`recordedAt`, the framework's clock) — also when its first
 * attempt started (#658: `attemptStartedAt`, `firstAttemptStartedAt`), which a store with a clock
 * of its own (a database's) writes by that clock instead.
 */
export const pendingOutboundCallOf = (
  key: EffectKey,
  intent: OutboundCallIntent,
  recordedAt: Date,
): OutboundCallRecord => ({
  ...intent,
  tenantId: key.tenantId,
  name: key.name,
  // the enum's value (a value import would make a cycle with the store module at load)
  status: "pending" as OutboundCallStatus.Pending,
  token: key.token,
  leaseExecutionId: key.leaseExecutionId,
  ...businessFactsOf(key),
  recordedAt: recordedAt.toISOString(),
  // its first attempt starts now (#658): a store with a clock of its own writes its time instead
  attemptStartedAt: recordedAt.toISOString(),
  firstAttemptStartedAt: recordedAt.toISOString(),
});

/**
 * A call as an operator's read, a kept record and an export show it (#508): a business key only by
 * its handle — never the key, in itself or inside the key the call went with — and never its
 * fingerprint (a digest of the request, kept in the store's row only, to tell a conflict).
 */
export function shownCallOf(record: OutboundCallRecord): OutboundCallRecord {
  const shown = { ...record };
  delete shown.fingerprint;
  if (record.businessKey === undefined) return shown;
  delete shown.businessKey;
  const handle = record.businessKeyHash === undefined ? "" : `${record.businessKeyHash}:`;
  return { ...shown, idempotencyKey: `business-key:${handle}${record.name}` };
}

export {
  FINGERPRINT_LABEL,
  fingerprintErrorOf,
  FingerprintPolicy,
  FingerprintProblem,
  FingerprintRequiredError,
  fingerprintsOf,
  fingerprintsUnder,
  IdempotencyKeyMissingError,
  type IdempotencyKeyMissingErrorOptions,
  isKeyFingerprint,
  type BusinessKeyOptions,
  type EffectKeyOptions,
  type FingerprintedKeyOptions,
  type FingerprintKeys,
  type FingerprintRequiredErrorOptions,
  type KeyFingerprints,
  type OutboundCallKeyOptions,
  type UnfingerprintedKeyOptions,
} from "./fenced-effect-fingerprint.js";
export {
  FingerprintNotJsonError,
  BusinessKeyConflictError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
  type InvalidFencedEffectNameErrorOptions,
  type BusinessKeyConflictErrorOptions,
  type FingerprintNotJsonErrorOptions,
  type InvalidBusinessKeyErrorOptions,
} from "./fenced-effect-errors.js";
