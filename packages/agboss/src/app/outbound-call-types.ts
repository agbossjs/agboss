import type { FencedEffectOrigin, JsonValue } from "../infrastructure/fenced-effect.repository.js";
import type { OutboundCallError } from "../core/error-families/effect-errors.js";
import type { Bytes, Milliseconds, Ttl } from "../units/index.js";
import type { NotSentTrust } from "./outbound-call-contract.js";
import type { OutboundRecovery, Reconciliation } from "./outbound-recovery.js";

/**
 * The shapes of a call that leaves the system (#505), as types only — the root import loads no
 * module for them; `idempotency.ts` re-exports them.
 */

/** What `send` gets: the call as it goes out. */
export interface OutboundCall<TRequest> {
  /** Send it with the call — the same on every attempt, every replay and every holder. */
  readonly idempotencyKey: string;
  /** The request as given (never the masked text the store keeps). */
  readonly request: TRequest;
  /** This attempt, from 1: 2 after a `notExecuted()` or a failed answer. */
  readonly attempt: number;
  readonly target: string;
  readonly operation: string;
  /** The step's signal (`executionContext.signal`): pass it to the client. */
  readonly signal: AbortSignal;
}

/**
 * What a lookup gets (#505): the call's key and the request as it was stored — masked by the
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

/** How a call that leaves the system is made: `Idempotency.sendOnce`'s options (#1317). */
export interface IdempotencySendOptions<TRequest, TResult> {
  /** The effect's name (1–100 of `[A-Za-z0-9._-]`): part of the key sent to the other system. */
  readonly name: string;
  /**
   * A business identity (`"order:42"`): the call is then one per tenant, name and key — deduplicated
   * across tool calls, visits, executions and threads — instead of one per step.
   */
  readonly key?: string;
  /** What the call goes to, for operators: `"stripe"`. */
  readonly target: string;
  /** What it does there: `"payment_intents.create"`; the call's `name` when left out. */
  readonly operation?: string;
  /** Plain JSON: `send` gets it as it is; it is stored masked by the PII policies. */
  readonly request: TRequest & JsonValue<TRequest>;
  /**
   * The bound of one attempt, from its start (required: Stripe and SEPA have other SLAs): its signal
   * (`call.signal`) aborts at it and at the step's cancel; until then its holder releases its lease
   * only once the attempt settled. At most 24 hours.
   */
  readonly timeout: Milliseconds;
  /** How long the call's rows are kept: above the lease's 30 s and, with a recovery window, at least it. */
  readonly ttl: Milliseconds | Ttl.Forever;
  /** Sends the call (with `call.idempotencyKey`); its answer is the result, plain JSON. */
  readonly send: (
    call: OutboundCall<TRequest>,
  ) => Promise<TResult & JsonValue<TResult>> | (TResult & JsonValue<TResult>);
  /** What to do with an intent left pending — the process died before the answer, or `send` threw an error of unknown outcome. */
  readonly recovery: OutboundRecovery<NoInfer<TResult>>;
  /**
   * Whether an error `send` threw proves the other system did **not** carry the call out (#657) — a
   * validation error, a decline it answered: the intent is `Failed`, and the next call sends it
   * again under the same key. Anything else is of unknown outcome and goes to `recovery`.
   */
  readonly isDefiniteFailure?: (error: unknown) => boolean;
  /** The largest request and the largest result, each in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxPayloadSize?: Bytes;
}

/**
 * What the protocol runs a call with, once its options are checked: the recovery as a lookup and
 * the trust it gives the lookup's `notExecuted()`.
 */
export interface OutboundCallRun<TRequest, TResult> {
  readonly name: string;
  readonly target: string;
  readonly operation: string;
  readonly request: TRequest & JsonValue<TRequest>;
  readonly timeout: Milliseconds;
  readonly maxPayloadSize: Bytes;
  readonly send: IdempotencySendOptions<TRequest, TResult>["send"];
  readonly isDefiniteFailure: ((error: unknown) => boolean) | undefined;
  readonly reconcile: (
    lookup: OutboundCallLookup,
  ) => Promise<Reconciliation<TResult>> | Reconciliation<TResult>;
  readonly notSent: OutboundCallNotSent;
}

/**
 * How far a `notExecuted()` is trusted: the lookup's word at any age, or the key's replay only while
 * the other system still keeps the key.
 */
export type OutboundCallNotSent = NotSentByLookup | NotSentByKeyReplay;

/** The lookup reads a record that does not expire: its `notExecuted()` is trusted at any age. */
export interface NotSentByLookup {
  readonly trust: NotSentTrust.Lookup;
  readonly keyRetention?: never;
}

/** The recovery relies on the other system replaying the key. */
export interface NotSentByKeyReplay {
  readonly trust: NotSentTrust.KeyReplay;
  /** How long the other system keeps an idempotency key, at least: a resend is made only while the key's age plus the call's `timeout` is below it. */
  readonly keyRetention: Milliseconds;
}

/** How a call got its result. */
export enum OutboundCallSendStatus {
  /** Sent now, and answered. */
  Sent = "sent",
  /** Completed before (a step run again): the result as it was stored — masked by the PII policies — nothing sent. */
  Replayed = "replayed",
  /** Left pending: the lookup found that it happened — its result, nothing sent. */
  Reconciled = "reconciled",
  /** The same call was being sent by this instance (two tool calls, two branches): its outcome, shared. */
  Joined = "joined",
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

/** Why a pending call could not be reconciled (a closed set of codes). */
export type OutboundCallUnreconciledReason = OutboundCallError.Unreconciled["reason"];

/** Why a completed call's result was not stored (a closed set of codes). */
export type OutboundCallResultNotStoredReason = OutboundCallError.ResultNotStored["reason"];
