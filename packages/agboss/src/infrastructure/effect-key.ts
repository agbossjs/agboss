import type { FingerprintPolicy } from "./fenced-effect-fingerprint.js";

/**
 * The key of one protected write (#500, #505, #508, #825): what it is made of, and the two branded
 * kinds — an `EffectKey` any fenced effect or call takes, an `OutboundCallKey` only a call takes.
 */

/** What a key of one protected write is made of: the lease scope and token, the step, a name. */
export interface EffectKeyFields {
  /** `executionContext.fence.scopeKey`: the lease scope, the key of its high-water mark. */
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The execution whose lease the step runs under (`executionContext.fence.leaseExecutionId`). */
  readonly leaseExecutionId: string;
  /** The lease's epoch the step holds (`executionContext.fence.token`). */
  readonly token: number;
  /** The step's `executionContext.step.idempotencyKey`: the same when the step runs again. */
  readonly idempotencyKey: string;
  /** Which effect of the step: `"charge"`, `"notify-ledger"` — several in one step are apart. */
  readonly name: string;
  /**
   * A business identity (#508, `"order:42"`): the effect is then one per tenant, name and business
   * key — deduplicated across tool calls, visits, executions and threads — instead of one per step.
   * Fencing is the caller's lease as always. A key's text (#538, `KeyTextRule`): validated by
   * `effectKeyOf`, `OutboundCalls.send` and every store's entry (`InvalidBusinessKeyError`).
   */
  readonly businessKey?: string;
  /**
   * What the effect does, as a keyed digest (#825: an HMAC of canonical JSON under the application's
   * idempotency key): another one under the same business key is `BusinessKeyConflictError`,
   * never a replay. Any text is a fingerprint, the empty one too (#574): `""` and none are two
   * requests — refused against each other, in flight or stored, so a store keeps `""` as `""`, never
   * as `NULL`. A store keeps this one only — never `previousFingerprint`.
   */
  readonly fingerprint?: string;
  /**
   * The same fingerprint under the application's previous idempotency key (#825, a rotation): a row
   * stored before the rotation is matched by it, so a call retried across the rotation replays. Never
   * stored; none when the application names no previous key.
   */
  readonly previousFingerprint?: string;
  /**
   * `FingerprintPolicy.None` (#825): the business key says on purpose that it has no fingerprint —
   * any work under it replays the first. Absent otherwise.
   */
  readonly fingerprintPolicy?: FingerprintPolicy;
  /** The step that made the key: what a replay from another step or execution names. */
  readonly origin?: FencedEffectOrigin;
  /**
   * The business key's handle (#508): 12 hex characters of its HMAC-SHA256 under the execution's PII
   * key — what an error shows instead of the key, to match it with the caller's own log. None where
   * no key is available (a key made by hand, outside an execution): an error then shows none.
   */
  readonly businessKeyHash?: string;
  /**
   * The tree whose cancel fences the key (#909): `executionContext.root.executionId`, set by
   * `effectKeyOf`. Absent means `leaseExecutionId` (a root's own lease). Read by a store only
   * through `cancelTreeOf`.
   */
  readonly rootExecutionId?: string;
  /**
   * Set by `effectKeyOf` for a step of an automatic undo (#909, `step.compensates`): a cancel never
   * refuses such a key — the cancel's own unwinding refunds and releases through it. Only
   * `effectKeyOf` and `effectKeyForTesting` set it: keys are issued (#825).
   */
  readonly isCompensation?: true;
}

/** What makes an `EffectKey` one (#825): a private member, which no object literal and no spread has. */
declare class EffectKeyMark {
  private readonly effectKeyMark: true;
}

/** What makes an `OutboundCallKey` one (#825). */
declare class OutboundCallKeyMark {
  private readonly outboundCallKeyMark: true;
}

/**
 * The key of one protected write — a fenced effect or a call that leaves the system (#825: only
 * `effectKeyOf` makes one for an application; a store's or a contract's test makes one with
 * `effectKeyForTesting`, `@agboss/core/testing/contracts`). Its mark is a private member, so neither
 * an object literal nor a copy (`{ ...key, token: key.token + 1 }`, which drops it) compiles as one;
 * and a key the framework did not make — a JavaScript caller's object, a cast — is refused at run
 * time, before anything runs: the framework knows the keys it made.
 */
export type EffectKey = EffectKeyFields & EffectKeyMark;

/**
 * A business key without a fingerprint of its own (#825): `effectKeyOf(executionContext, name, {
 * businessKey })`. Only `OutboundCalls.send` takes it — its request is its fingerprint; a fenced
 * effect needs `fingerprint` or `fingerprintPolicy: FingerprintPolicy.None` (a compile error, and
 * `FingerprintRequiredError` for a JavaScript caller).
 */
export type OutboundCallKey = EffectKeyFields & OutboundCallKeyMark;

/** A step, as a replay from another one names it (#508). */
export interface FencedEffectOrigin {
  readonly executionId: string;
  readonly nodeId: string;
  readonly visitNumber: number;
}

/** The marks, as types only (#825): no value exists, so none is made or checked against at run time. */
export type { EffectKeyMark, OutboundCallKeyMark };
