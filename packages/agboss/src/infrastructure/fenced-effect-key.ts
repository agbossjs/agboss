import { AGBossError } from "../core/errors.js";
import type { ExecutionContext } from "../flow/context/execution-context.js";
import { currentFrame } from "../flow/context/frame.js";
import { keyedDigestOf } from "../pii/tokens.js";
import { isThreadId } from "../run/thread.js";
import { versionOf } from "../terns/index.js";
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
  /** `"order:42"`: 1–200 characters, no control characters. Never sent to a model. */
  readonly businessKey: string;
  /**
   * What the effect does (plain JSON, hashed with SHA-256 over canonical JSON): another value
   * under the same business key is `IdempotencyKeyConflictError`. `OutboundCalls.send` takes its
   * request's when none is given.
   */
  readonly fingerprint?: JsonResult<TFingerprint>;
}

/** The fingerprint of `value`: SHA-256 of its canonical JSON. */
export const fingerprintOf = (value: unknown): string => versionOf(value);

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
  if (!isThreadId(options.businessKey))
    throw new InvalidBusinessKeyError({
      name,
      problem: "1 to 200 characters, no control characters",
    });
  const fingerprint =
    options.fingerprint === undefined ? {} : { fingerprint: fingerprintOf(options.fingerprint) };
  const businessKeyHash = businessKeyHashOf(options.businessKey);
  const handle = businessKeyHash === undefined ? {} : { businessKeyHash };
  return Object.freeze({ ...key, businessKey: options.businessKey, ...fingerprint, ...handle });
}

/** What an invalid business key knows: the effect, and why — never the key itself. */
export interface InvalidBusinessKeyErrorOptions {
  readonly name: string;
  readonly problem: string;
}

/**
 * A business key that is not one (#508): empty, longer than 200 characters, or with a control
 * character — the rule of thread ids. Nothing ran; the key is not named (it may carry an id).
 */
export class InvalidBusinessKeyError extends AGBossError {
  static override readonly code: string = "fenced-effect.invalid-business-key";
  override name = "InvalidBusinessKeyError";
  readonly effect: string;

  constructor(options: InvalidBusinessKeyErrorOptions) {
    super(`the business key of "${options.name}" is not one: ${options.problem}`);
    this.effect = options.name;
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
 * name — or, with a business key, by the tenant, the name and the business key.
 */
export const identityOf = (key: FencedEffectKey): string =>
  key.businessKey === undefined
    ? [key.scopeKey, key.idempotencyKey, key.name].join("\u0000")
    : ["business", key.tenantId, key.name, key.businessKey].join("\u0000");

/** What a stored row keeps of the key that wrote it (#508). */
export interface StoredKeyFacts {
  readonly fingerprint?: string | undefined;
  readonly origin?: FencedEffectOrigin | undefined;
}

/** The facts of `key` a row keeps: its fingerprint and its step, when it has them. */
export const storedFactsOf = (key: FencedEffectKey): StoredKeyFacts => ({
  ...(key.fingerprint === undefined ? {} : { fingerprint: key.fingerprint }),
  ...(key.origin === undefined ? {} : { origin: key.origin }),
});

const sameOrigin = (left: FencedEffectOrigin, right: FencedEffectOrigin | undefined): boolean =>
  left.executionId === right?.executionId &&
  left.nodeId === right.nodeId &&
  left.visitNumber === right.visitNumber;

/**
 * A stored row found for `key` (#508): another fingerprint under its business key is
 * `IdempotencyKeyConflictError`; a row another step or execution wrote is named as `replayedFrom`.
 */
export function replayedFromOf(
  key: FencedEffectKey,
  stored: StoredKeyFacts,
): FencedEffectOrigin | undefined {
  if (key.businessKey === undefined) return undefined;
  if (stored.fingerprint !== key.fingerprint)
    throw new IdempotencyKeyConflictError({ name: key.name, businessKeyHash: key.businessKeyHash });
  const { origin } = stored;
  return origin === undefined || sameOrigin(origin, key.origin) ? undefined : origin;
}

/** What a result too large to store knows: the effect, its size and the limit (UTF-8 bytes). */
export interface FencedEffectResultTooLargeErrorOptions {
  /** The effect's `name` (`fencedEffectKeyOf(executionContext, name)`). */
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;
}

/**
 * A fenced effect's result is larger than `@Application({ fencedEffects: { maxResultSize } })`
 * (#500, default 64 KB): its transaction is rolled back — the business rows too — and the step
 * fails with it. Store a reference (an id, a receipt number), not the document.
 */
export class FencedEffectResultTooLargeError extends AGBossError {
  static override readonly code: string = "fenced-effect.result-too-large";
  override name = "FencedEffectResultTooLargeError";
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;

  constructor(options: FencedEffectResultTooLargeErrorOptions) {
    super(
      `the result of fenced effect "${options.effect}" is ${String(options.size)} bytes, above its maxResultSize of ${String(options.maxResultSize)} bytes: nothing was written — store a reference to it, or raise @Application({ fencedEffects: { maxResultSize } })`,
    );
    this.effect = options.effect;
    this.size = options.size;
    this.maxResultSize = options.maxResultSize;
  }
}

/** Which stores do not match: the fenced-effect store and the lease store the application uses. */
export interface FencedEffectStoreMismatchErrorOptions {
  readonly fencedEffectRepository: string;
  readonly leaseRepository: string;
  /** The lease store the fenced-effect store reads its leases from. */
  readonly expectedLeaseRepository: string;
}

/**
 * The fenced-effect store reads the leases of another store than the application's (#500): the
 * built-in in-memory one used beside a listed `SqliteExecutionLeaseRepository`, say. It would
 * refuse every write, so the first call fails with this instead — list the fenced-effect store of
 * the lease store's database (`SqliteFencedEffectRepository` beside `SqliteExecutionLeaseRepository`).
 */
export class FencedEffectStoreMismatchError extends AGBossError {
  static override readonly code: string = "fenced-effect.store-mismatch";
  override name = "FencedEffectStoreMismatchError";
  readonly fencedEffectRepository: string;
  readonly leaseRepository: string;

  constructor(options: FencedEffectStoreMismatchErrorOptions) {
    super(
      `${options.fencedEffectRepository} checks the leases of ${options.expectedLeaseRepository}, but the application's leases are in ${options.leaseRepository}: list the fenced-effect store of that lease store's database in @Application({ providers })`,
    );
    this.fencedEffectRepository = options.fencedEffectRepository;
    this.leaseRepository = options.leaseRepository;
  }
}

/** A key's business identity as a record keeps it (#508): none for a step's key. */
export const businessFactsOf = (
  key: FencedEffectKey,
): { readonly businessKey?: string; readonly fingerprint?: string } => ({
  ...(key.businessKey === undefined ? {} : { businessKey: key.businessKey }),
  ...(key.fingerprint === undefined ? {} : { fingerprint: key.fingerprint }),
});
