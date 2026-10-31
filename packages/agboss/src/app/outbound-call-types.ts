import type { FencedEffectOrigin, JsonResult } from "../infrastructure/fenced-effect.repository.js";
import type {
  OutboundCallOutcomeStatus,
  OutboundCallPart,
  OutboundCallReconciliation,
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
  readonly target: string;
  readonly operation: string;
  /** The step's signal (`executionContext.signal`): pass it to the client. */
  readonly signal: AbortSignal;
}

/** How a call that leaves the system is made: what, where, and the two hooks. */
export interface OutboundCallOptions<TRequest, TResult> {
  /** What the call goes to, for operators: `"payments"`. */
  readonly target: string;
  /** What it does there: `"charge"`. */
  readonly operation: string;
  /** Plain JSON: `send` gets it as it is; it is stored masked by the PII policies. */
  readonly request: TRequest & JsonResult<TRequest>;
  /** Sends the call (with `call.idempotencyKey`); its answer is the result, plain JSON. */
  readonly send: (
    call: OutboundCall<TRequest>,
  ) => Promise<TResult & JsonResult<TResult>> | (TResult & JsonResult<TResult>);
  /**
   * Asked only for an intent left pending — the process died, or lost its lease, before the
   * answer: what happened, from the other system, looked up by `lookup.idempotencyKey`.
   */
  readonly reconcile: (
    lookup: OutboundCallLookup,
  ) => Promise<OutboundCallReconciliation<TResult>> | OutboundCallReconciliation<TResult>;
}

/** What `send` gives: how, the result, the attempt it came from and the key it went with. */
export interface OutboundCallOutcome<TResult> {
  readonly status: OutboundCallOutcomeStatus;
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

/** What the store keeps an unreconciled call by, for its error. */
export interface OutboundCallUnreconciledErrorOptions {
  readonly name: string;
  readonly target: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

/** What a payload too large to store knows: the call, its part, its size and the limit (bytes). */
export interface OutboundCallPayloadTooLargeErrorOptions {
  readonly call: string;
  readonly part: OutboundCallPart;
  readonly size: number;
  readonly maxPayloadSize: number;
}

/** What an in-flight call knows: the call, never its request or its business key. */
export interface OutboundCallInFlightErrorOptions {
  readonly name: string;
  readonly target: string;
  readonly operation: string;
}
