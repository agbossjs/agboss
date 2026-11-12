import type { FencedEffectOrigin, JsonValue } from "../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { NotSentTrust } from "./outbound-call-contract.js";
import type {
  OutboundCallSendStatus,
  OutboundCallPart,
  OutboundCallPayloadTooLargeError,
  OutboundCallReconciliation,
  OutboundCallUnmaskedError,
} from "./outbound-calls.js";

/**
 * The shapes of a call that leaves the system (#505), as types only — the root import loads no
 * module for them; `outbound-calls.ts` re-exports them.
 */

/** What `send` and `reconcile` get: the call as it goes out. */
export interface OutboundCall<TRequest> {
  /** Send it with the call — the same on every attempt, every replay and every holder. */
  readonly idempotencyKey: string;
  /** The request as given (never the masked text the store keeps). */
  readonly request: TRequest;
  /** This attempt, from 1: 2 after `notSent()` or a failed answer. */
  readonly attempt: number;
  readonly target: string;
  readonly operation: string;
  /** The step's signal (`executionContext.signal`): pass it to the client. */
  readonly signal: AbortSignal;
}

/**
 * What `reconcile` gets (#505): the call's key and the request as it was stored — masked by the
 * PII policies, so look the call up in the other system by `idempotencyKey`, which is not personal
 * data; the real request is the step's own input, when it needs it.
 */
export interface OutboundCallLookup {
  /** The key the call went with: what the other system finds it by. */
  readonly idempotencyKey: string;
  /** The request's JSON as stored: masked by the application's and the workflow's PII policies. */
  readonly storedRequest: string;
  /** The attempt left pending, from 1. */
  readonly attempt: number;
  /**
   * When the attempt left pending started (#658) — claimed, right before it was sent — on the
   * store's clock: the database's own on PostgreSQL, the same on every instance and after a
   * takeover. `undefined` for an intent its store recorded without it (one written before 0.1.1).
   */
  readonly attemptStartedAt: Date | undefined;
  /**
   * How old the key is (#658): from the start of the call's first attempt — before the key could
   * reach the other system — to now, on the store's clock (its reading at the lookup, plus what
   * passed since on this instance's monotonic clock): at least as old as the other system's
   * record of the key. `undefined` when the store did not record the first attempt's start.
   */
  readonly keyAge: Milliseconds | undefined;
  readonly target: string;
  readonly operation: string;
  /** The step's signal (`executionContext.signal`): pass it to the client. */
  readonly signal: AbortSignal;
}

/** How a call that leaves the system is made: what, where, and the two hooks. */
export interface OutboundCallSendOptions<TRequest, TResult> {
  /** What the call goes to, for operators: `"payments"`. */
  readonly target: string;
  /** What it does there: `"charge"`. */
  readonly operation: string;
  /** Plain JSON: `send` gets it as it is; it is stored masked by the PII policies. */
  readonly request: TRequest & JsonValue<TRequest>;
  /** Sends the call (with `call.idempotencyKey`); its answer is the result, plain JSON. */
  readonly send: (
    call: OutboundCall<TRequest>,
  ) => Promise<TResult & JsonValue<TResult>> | (TResult & JsonValue<TResult>);
  /**
   * Asked only for an intent left pending — the process died, or lost its lease, before the
   * answer, or `send` threw an error of unknown outcome: what happened, from the other system,
   * looked up by `lookup.idempotencyKey` or a reference that does not expire.
   */
  readonly reconcile: (
    lookup: OutboundCallLookup,
  ) => Promise<OutboundCallReconciliation<TResult>> | OutboundCallReconciliation<TResult>;
  /**
   * Whether an error `send` threw proves the other system did **not** carry the call out (#657) —
   * a validation error, a decline it answered: the intent is `Failed`, and the next call sends it
   * again under the same key. Anything else is of unknown outcome — no predicate, an answer other
   * than `true`, a predicate that throws: a 5xx, a reset connection, the SDK's own timeout may
   * come after the other system acted. The intent then stays `Pending`, and the next call asks
   * `reconcile` before anything is sent again, as after a crash.
   */
  readonly isDefiniteFailure?: (error: unknown) => boolean;
  /**
   * How far a `notSent()` of `reconcile` is trusted (#795) — required, so the author says it:
   * `{ trust: NotSentTrust.Lookup }` when `reconcile` reads a record the other system keeps for
   * good (its books, a list of refunds), `{ trust: NotSentTrust.KeyReplay, keyRetention }` when it
   * relies on the other system replaying the key (a gateway whose only lookup is the replay, or
   * whose search lags). Anything else is refused before anything is recorded or sent
   * (`InvalidNotSentTrustError`).
   */
  readonly notSent: OutboundCallNotSent;
}

/**
 * How far a `notSent()` is trusted (#795): the lookup's word at any age, or the key's replay only
 * while the other system still keeps the key.
 */
export type OutboundCallNotSent = NotSentByLookup | NotSentByKeyReplay;

/** `reconcile` reads a record that does not expire: its `notSent()` is trusted at any age. */
export interface NotSentByLookup {
  readonly trust: NotSentTrust.Lookup;
  /** A lookup has no retention: the record it reads does not expire. */
  readonly keyRetention?: never;
}

/** `reconcile`'s `notSent()` relies on the other system replaying the key. */
export interface NotSentByKeyReplay {
  readonly trust: NotSentTrust.KeyReplay;
  /**
   * How long the other system keeps an idempotency key, at least (#658: its documented minimum —
   * Stripe `hours(24)`, Checkout.com `hours(72)`, Adyen `hours(168)`): a `notSent()` is sent again
   * only while `lookup.keyAge` plus `outboundCalls.attemptTimeout` (how long the resend may take to
   * arrive) is below it; else nothing is sent — `OutboundCallUnreconciledError`, the intent pending
   * for an operator. A positive, finite duration.
   */
  readonly keyRetention: Milliseconds;
}

/** What `send` gives: how, the result, the attempt it came from and the key it went with. */
export interface OutboundCallOutcome<TResult> {
  readonly status: OutboundCallSendStatus;
  readonly result: TResult;
  readonly attempt: number;
  readonly idempotencyKey: string;
  /** A business key's replay of a call another step or execution made (#508): that step. */
  readonly replayedFrom?: FencedEffectOrigin;
}

/** Why the other system cannot say what happened. */
export interface OutboundCallUnknownOptions {
  readonly reason: string;
}

/**
 * Why a pending call could not be reconciled (#890: a closed set of codes): `reconcile` said
 * `unknown({ reason })`, threw, or gave no verdict; or it said `notSent()` for a key past its
 * `KeyReplay`'s `keyRetention` (#658) — a resend could be a new call.
 */
export type OutboundCallUnreconciledReason =
  "reconcile.unknown" | "reconcile.threw" | "reconcile.no-verdict" | "key-retention.passed";

/** What an unreconciled call knows: the call, its key's handle, why — never its request. */
export interface OutboundCallUnreconciledErrorOptions {
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly reason: OutboundCallUnreconciledReason;
  /** What was said, masked: `unknown`'s own reason, the thrown error's message, the key's age. */
  readonly detail: string;
  /** What `reconcile` threw, when it threw. */
  readonly cause?: unknown;
}

/** What a payload too large to store knows: the call, its part, its size and the limit (bytes). */
export interface OutboundCallPayloadTooLargeErrorOptions {
  readonly call: string;
  readonly part: OutboundCallPart;
  readonly size: number;
  readonly maxPayloadSize: number;
  readonly cause?: unknown;
}

/** What a superseded attempt knows (#795): the call, its key's handle and both attempts. */
export interface OutboundCallSupersededErrorOptions {
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  /** The attempt that was answered too late. */
  readonly attempt: number;
  /** The newer attempt that took the intent over; `undefined` when the intent could not be read. */
  readonly supersededBy: number | undefined;
  /** What the late attempt itself answered when that was an error (a definite failure). */
  readonly cause?: unknown;
}

/** What a refused unmasked call knows (#906): the call. */
export interface OutboundCallUnmaskedErrorOptions {
  readonly call: string;
  readonly cause?: unknown;
}

/** What an in-flight call knows: the call, never its request or its business key. */
export interface OutboundCallInFlightErrorOptions {
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly cause?: unknown;
}

/**
 * Why a completed call's result was not stored (#890: a closed set of codes): above
 * `maxPayloadSize`, refused for want of a mask, or any other failure to store it (its JSON, the
 * mask itself) — the instance's log names that one's own code.
 */
export type OutboundCallResultNotStoredReason =
  | typeof OutboundCallPayloadTooLargeError.code
  | typeof OutboundCallUnmaskedError.code
  | "outbound-call.result-unstorable";

/** What a completed call without a stored result knows: the call, and why it was not stored. */
export interface OutboundCallResultNotStoredErrorOptions extends OutboundCallInFlightErrorOptions {
  readonly reason: OutboundCallResultNotStoredReason;
}
