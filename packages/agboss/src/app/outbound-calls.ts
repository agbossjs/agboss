import { Injectable } from "../components/decorators.js";
import { AGBossError } from "../core/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { OutboundCallSettings } from "../infrastructure/fenced-effect-settings.js";
import type { FencedEffectKey, JsonResult } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";

/**
 * `OutboundCalls` (#505): a call that leaves the system, sent through the protocol — the intent
 * recorded before the call in a fenced write, completed or failed after it, and an intent left
 * pending reconciled with the other system, never sent again blindly. The protocol itself loads
 * on the first call (`outbound-call-protocol.ts`). Wiki → Several-instances.
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

/** How a call got its result. */
export enum OutboundCallOutcomeStatus {
  /** Sent now, and answered. */
  Sent = "sent",
  /**
   * Completed before (a step run again): the result as it was stored — masked by the PII policies
   * (store references and ids in a result, not personal data) — nothing sent.
   */
  Replayed = "replayed",
  /** Left pending: `reconcile` found that it happened — its result, nothing sent. */
  Reconciled = "reconciled",
}

/** What `send` gives: how, the result, the attempt it came from and the key it went with. */
export interface OutboundCallOutcome<TResult> {
  readonly status: OutboundCallOutcomeStatus;
  readonly result: TResult;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

/** What `reconcile` found. */
export enum OutboundCallVerdict {
  /** It happened: here is its result. */
  Completed = "completed",
  /** It never arrived: send it, with the same key. */
  NotSent = "not-sent",
  /** The other system cannot say: the step fails, the intent stays pending. */
  Unknown = "unknown",
}

/** Why the other system cannot say what happened. */
export interface OutboundCallUnknownOptions {
  readonly reason: string;
}

/**
 * The answer of `reconcile` (#505): built only with `completed(result)`, `notSent()` or
 * `unknown({ reason })` — nominal, a plain object is not one.
 */
export class OutboundCallReconciliation<TResult> {
  /** Nominal: a plain `{ verdict }` object is not a verdict. */
  declare private readonly built: true;
  readonly verdict: OutboundCallVerdict;
  /** The other system's result (`Completed`). */
  readonly result: TResult | undefined;
  /** Why it cannot say (`Unknown`); empty for the others. */
  readonly reason: string;

  private constructor(verdict: OutboundCallVerdict, result?: TResult, reason = "") {
    this.verdict = verdict;
    this.result = result;
    this.reason = reason;
    Object.freeze(this);
  }

  /** The call happened: the step goes on with `result` (stored, `Reconciled`), nothing is sent. */
  static completed<TResult>(
    result: TResult & JsonResult<TResult>,
  ): OutboundCallReconciliation<TResult> {
    return new OutboundCallReconciliation<TResult>(OutboundCallVerdict.Completed, result);
  }

  /** The call never arrived: it is sent once more, with the same key and the next attempt. */
  static notSent(): OutboundCallReconciliation<never> {
    return new OutboundCallReconciliation<never>(OutboundCallVerdict.NotSent);
  }

  /** Nobody can say: `OutboundCallUnreconciledError`, the intent pending for an operator. */
  static unknown(options: OutboundCallUnknownOptions): OutboundCallReconciliation<never> {
    return new OutboundCallReconciliation<never>(
      OutboundCallVerdict.Unknown,
      undefined,
      options.reason,
    );
  }
}

/**
 * The application's calls that leave the system (#505): a core service a component injects
 * (`deps: [ExecutionContext, OutboundCalls]`), over the listed `OutboundCallRepository`.
 */
@Injectable({ deps: [OutboundCallRepository, OutboundCallSettings] })
export class OutboundCalls {
  constructor(
    private readonly repository: OutboundCallRepository,
    private readonly settings: OutboundCallSettings,
  ) {}

  /**
   * Sends the call of `key` (`fencedEffectKeyOf(executionContext, name)`) at most once per
   * outcome: completed → its stored result (`Replayed`); left pending → `reconcile` decides;
   * failed → sent again with the same key; none → recorded, then sent. A zombie's call is refused
   * (`ExecutionFencedError`) before anything is recorded or sent.
   */
  async send<TRequest, TResult>(
    key: FencedEffectKey,
    options: OutboundCallOptions<TRequest, TResult>,
  ): Promise<OutboundCallOutcome<TResult>> {
    const { sendOutboundCall } = await import("./outbound-call-protocol.js");
    return sendOutboundCall({ repository: this.repository, settings: this.settings }, key, options);
  }
}

/** What the store keeps an unreconciled call by, for its error. */
export interface OutboundCallUnreconciledErrorOptions {
  readonly name: string;
  readonly target: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

/**
 * An intent left pending could not be reconciled (#505): `reconcile` said `unknown`, threw (its
 * error the `cause`), or gave no verdict. Nothing was sent; the intent stays `Pending`, listed by
 * `app.pendingOutboundCalls` for an operator. A `StepFailedError`: `.onError(…)` may take it.
 */
export class OutboundCallUnreconciledError extends StepFailedError {
  static override readonly code: string = "outbound-call.unreconciled";
  override name = "OutboundCallUnreconciledError";
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly reason: string;

  constructor(options: OutboundCallUnreconciledErrorOptions, cause?: unknown) {
    const { name, target, operation, idempotencyKey, reason } = options;
    super(
      `outbound call "${name}" (${operation} on ${target}, key ${idempotencyKey}) is left pending and could not be reconciled: ${reason} — nothing was sent; an operator decides (app.pendingOutboundCalls)`,
      [],
      cause,
      stepCoordinatesOf(name, ComponentKind.Action),
      { call: name, target, operation, reason },
    );
    this.call = name;
    this.target = target;
    this.operation = operation;
    this.idempotencyKey = idempotencyKey;
    this.reason = reason;
  }
}

/** Which part of a call is too large. */
export enum OutboundCallPart {
  Request = "request",
  Result = "result",
}

/** What a payload too large to store knows: the call, its part, its size and the limit (bytes). */
export interface OutboundCallPayloadTooLargeErrorOptions {
  readonly call: string;
  readonly part: OutboundCallPart;
  readonly size: number;
  readonly maxPayloadSize: number;
}

/**
 * A call's request or result is larger than `@Application({ outboundCalls: { maxPayloadSize } })`
 * (#505, default 64 KB). A request: nothing was recorded or sent. A result: the call was answered,
 * its intent stays pending, so the next attempt reconciles it.
 */
export class OutboundCallPayloadTooLargeError extends AGBossError {
  static override readonly code: string = "outbound-call.payload-too-large";
  override name = "OutboundCallPayloadTooLargeError";
  readonly call: string;
  readonly part: OutboundCallPart;
  readonly size: number;
  readonly maxPayloadSize: number;

  constructor(options: OutboundCallPayloadTooLargeErrorOptions) {
    super(
      `the ${options.part} of outbound call "${options.call}" is ${String(options.size)} bytes, above its maxPayloadSize of ${String(options.maxPayloadSize)} bytes — send and store a reference, or raise @Application({ outboundCalls: { maxPayloadSize } })`,
    );
    this.call = options.call;
    this.part = options.part;
    this.size = options.size;
    this.maxPayloadSize = options.maxPayloadSize;
  }
}

/**
 * A call that leaves the system would have stored its request unmasked (#505): the application or
 * one of its workflows lists PII policies, but the step's frame carries no mask to apply them.
 * Nothing was recorded or sent — the framework fails closed rather than store personal data raw.
 */
export class OutboundCallUnmaskedError extends AGBossError {
  static override readonly code: string = "outbound-call.unmasked";
  override name = "OutboundCallUnmaskedError";
  readonly call: string;

  constructor(call: string) {
    super(
      `outbound call "${call}" was refused: the application lists PII policies, but this step has no mask to store its request with — nothing was recorded or sent`,
    );
    this.call = call;
  }
}

/** What is stored of a failure's text where no mask can be applied (#505): never the text. */
export const REDACTED = "[redacted]";
