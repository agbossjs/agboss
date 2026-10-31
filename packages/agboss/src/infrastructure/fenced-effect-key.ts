import { AGBossError } from "../core/errors.js";
import type { ExecutionContext } from "../flow/context/execution-context.js";
import { currentFrame } from "../flow/context/frame.js";
import { keyedDigestOf } from "../pii/tokens.js";
import type { OutboundCallIntent, OutboundCallRecord } from "./outbound-call-record.js";
import type { OutboundCallStatus } from "./outbound-call.repository.js";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf, type KeyTextRule } from "../core/errors.js";
import { stableJson, versionOf } from "../terns/index.js";
import type {
  FencedEffectKey,
  FencedEffectOrigin,
  JsonResult,
} from "./fenced-effect.repository.js";

/**
 * The key of a fenced effect or of an outbound call (#500, #505), and its business identity
 * (#508): by default one key per step and name; with a business key one per tenant, name and
 * business key — deduplicated across tool calls, visits, executions and threads — with a
 * fingerprint of what the effect does, so the same key with other parameters is a conflict.
 */

/** A business identity for a key (#508). */
export interface FencedEffectKeyOptions<TFingerprint = unknown> {
  /**
   * `"order:42"`: a key's text (#538, `KeyTextRule`) — 1–200 characters, no control or format
   * character, no lone surrogate, in NFC. Never sent to a model.
   */
  readonly businessKey: string;
  /**
   * What the effect does (plain JSON, hashed with SHA-256 over canonical JSON): another value
   * under the same business key is `IdempotencyKeyConflictError`. `OutboundCalls.send` takes its
   * request's when none is given.
   */
  readonly fingerprint?: JsonResult<TFingerprint>;
}

/** The label the fingerprint's subkey is derived under (#508): `HMAC(applicationKey, label)`. */
export const FINGERPRINT_LABEL = "agboss/fingerprint/v1";

/**
 * The fingerprint of `value` (#508): an HMAC-SHA256 of its canonical JSON under a subkey of the
 * application's `pseudonymKey` — the same in every execution and on every instance, so a business
 * key's calls compare across them, and no guessable request can be found from it. An application
 * without a `pseudonymKey` has no key its instances share: its fingerprints are a SHA-256 under the
 * same label (the startup warning `[application.pii-instance-key]` says so).
 */
export function fingerprintOf(value: unknown): string {
  const text = `fingerprint\u0000${stableJson(value)}`;
  const key = currentFrame()?.execution.fingerprintKey;
  if (key === undefined) return versionOf(`${FINGERPRINT_LABEL}\u0000${text}`);
  return keyedDigestOf(keyedDigestOf(key, FINGERPRINT_LABEL), text);
}

/**
 * Checks an effect's name (#508): 1–100 of `[A-Za-z0-9._-]`, else `InvalidFencedEffectNameError` —
 * by `fencedEffectKeyOf` and again at every store's entry, for a key built by hand (exported for
 * stores outside the core, #526: before any statement, as the core's stores check it).
 */
export function checkedEffectName(name: string): void {
  if (!isEffectName(name)) throw new InvalidFencedEffectNameError(name.length);
}

/**
 * Checks a key's business key (#538): a key's text (`keyTextRuleOf`), else
 * `InvalidBusinessKeyError` naming the rule, never the key — by `fencedEffectKeyOf`,
 * `OutboundCalls.send` and again at every store's entry, for a key built by hand (exported for
 * stores outside the core: before any statement, beside `checkedEffectName`).
 */
export function checkedBusinessKey(key: Pick<FencedEffectKey, "name" | "businessKey">): void {
  const invalid = businessKeyErrorOf(key);
  if (invalid !== undefined) throw invalid;
}

/** The `InvalidBusinessKeyError` of `key`'s business key (#538), `undefined` when it has a valid one or none. */
export function businessKeyErrorOf(
  key: Pick<FencedEffectKey, "name" | "businessKey">,
): InvalidBusinessKeyError | undefined {
  const rule = key.businessKey === undefined ? undefined : keyTextRuleOf(key.businessKey);
  return rule === undefined ? undefined : new InvalidBusinessKeyError({ name: key.name, rule });
}

/** Whether `name` is an effect's name (#508): 1–100 of `[A-Za-z0-9._-]`, a letter or digit first. */
export const isEffectName = (name: string): boolean => EFFECT_NAME.test(name);

/**
 * The key of the current step's effect `name` (#500): the lease the step runs under
 * (`executionContext.fence`) and its idempotency key (`executionContext.step`) — the same when the
 * step runs again after a crash, a newer token once another instance took the lease over. With
 * `{ businessKey, fingerprint? }` (#508) the identity is the tenant, the name and the business key
 * — an invalid one throws `InvalidBusinessKeyError`. Where no lease is held (a reply interpreter,
 * `maxSpend()`, a yielded lease, an ancestor's context) it throws `ExecutionContextUnavailableError`,
 * as `fence` does.
 */
export function fencedEffectKeyOf<TFingerprint>(
  executionContext: ExecutionContext,
  name: string,
  options?: FencedEffectKeyOptions<TFingerprint>,
): FencedEffectKey {
  checkedEffectName(name);
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
  if (options === undefined) return Object.freeze(key);
  checkedBusinessKey({ name, businessKey: options.businessKey });
  const fingerprint =
    options.fingerprint === undefined ? {} : { fingerprint: fingerprintOf(options.fingerprint) };
  const businessKeyHash = businessKeyHashOf(options.businessKey);
  const handle = businessKeyHash === undefined ? {} : { businessKeyHash };
  return Object.freeze({ ...key, businessKey: options.businessKey, ...fingerprint, ...handle });
}

/** An effect's name (#508): letters, digits, `.`, `_`, `-`, 1–100 — never a `:` of the keys it is in. */
const EFFECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

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
 * A business key's handle (#508): 12 hex characters of an HMAC-SHA256 of `business-key\0<key>` under
 * a subkey derived from the PII key of the execution running now (its own, #334, else the
 * application's `pseudonymKey`) — a business key is guessable (`order:42`), so never a plain hash,
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
 * The same business key with another fingerprint (#508): `order:42` charged $10, then $12. Never
 * replayed, nothing ran or was sent — a bug or a tampered request, for a person to look at. Neither
 * the key nor any value is in the error (a business key carries ids): `businessKeyHash` correlates
 * it with the caller's own log.
 */
export class IdempotencyKeyConflictError extends AGBossError {
  static override readonly code: string = "fenced-effect.key-conflict";
  override name = "IdempotencyKeyConflictError";
  readonly effect: string;
  /** The business key's handle, when one could be made (`FencedEffectKey.businessKeyHash`). */
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
 * Where a key's row is found (#508): by its step — the scope, the step's idempotency key, the
 * name — or, with a business key, by the tenant, the name and the business key. One text, the
 * parts joined by NUL (exported for stores outside the core, #526: a key-value store's row key).
 */
export const fencedKeyIdentityOf = (key: FencedEffectKey): string =>
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
  key: FencedEffectKey,
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
 * is a fingerprint, not none (#574) — is
 * `IdempotencyKeyConflictError` (never a replay, the key not named); a row another step or
 * execution wrote is named as `replayedFrom`. `undefined` for a step's own key, a row of the key's
 * own step, or one without its step.
 */
export function replayedFromOf(
  key: FencedEffectKey,
  stored: StoredKeyFacts,
): FencedEffectOrigin | undefined {
  if (key.businessKey === undefined) return undefined;
  if ((stored.fingerprint ?? undefined) !== key.fingerprint)
    throw new IdempotencyKeyConflictError({ name: key.name, businessKeyHash: key.businessKeyHash });
  const origin = storedOriginOf(stored.origin);
  return origin === undefined || sameOrigin(origin, key.origin) ? undefined : origin;
}

/** A key's business identity as a record keeps it (#508): none for a step's key. */
const businessFactsOf = (
  key: FencedEffectKey,
): Pick<OutboundCallRecord, "businessKey" | "fingerprint" | "businessKeyHash"> => ({
  ...(key.businessKey === undefined ? {} : { businessKey: key.businessKey }),
  ...(key.fingerprint === undefined ? {} : { fingerprint: key.fingerprint }),
  ...(key.businessKeyHash === undefined ? {} : { businessKeyHash: key.businessKeyHash }),
});

/**
 * The record `saveIfAbsent` keeps for `key`'s intent (#505, exported for stores outside the core,
 * #526): the intent as given, `Pending` under the key's lease and token, its business identity
 * (#508) and when it was recorded (`recordedAt`, the framework's clock).
 */
export const pendingOutboundCallOf = (
  key: FencedEffectKey,
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
