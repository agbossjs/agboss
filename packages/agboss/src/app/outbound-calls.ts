import { markBusinessKeyWriter } from "../components/container/fenced-reach.js";
import { Injectable } from "../components/decorators.js";
import { AGBossError } from "../core/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { assertBusinessKey, assertEffectName } from "../infrastructure/fenced-effect-key.js";
import { OutboundCallSettings } from "../infrastructure/fenced-effect-settings.js";
import type { EffectKey, OutboundCallKey } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
import { Clock, lazyLoad } from "../infrastructure/clock.js";
import { frameworkLogOf, Logger } from "../infrastructure/logger.js";
import { callKeyErrorOf, checkedNotSentTrust } from "./outbound-call-contract.js";
import type { LiveCall } from "./outbound-call-parts.js";
import type {
  OutboundCallInFlightErrorOptions,
  OutboundCallSendOptions,
  OutboundCallOutcome,
  OutboundCallPayloadTooLargeErrorOptions,
  OutboundCallUnreconciledErrorOptions,
} from "./outbound-call-types.js";

export {
  isReconciliation,
  OutboundCallReconciliation,
  OutboundCallVerdict,
  type CompletedReconciliation,
  type NotSentReconciliation,
  type UnknownReconciliation,
} from "./outbound-call-reconciliation.js";
export type {
  OutboundCall,
  OutboundCallInFlightErrorOptions,
  OutboundCallLookup,
  OutboundCallSendOptions,
  OutboundCallOutcome,
  OutboundCallPayloadTooLargeErrorOptions,
  OutboundCallUnknownOptions,
  OutboundCallUnreconciledErrorOptions,
} from "./outbound-call-types.js";

/**
 * `OutboundCalls` (#505): a call that leaves the system, sent through the protocol — the intent
 * recorded before the call in a fenced write, completed or failed after it, and an intent left
 * pending reconciled with the other system, never sent again blindly. The protocol itself loads
 * on the first call (`outbound-call-protocol.ts`). Wiki → Several-instances.
 */

/** How a call got its result. */
export enum OutboundCallSendStatus {
  /** Sent now, and answered. */
  Sent = "sent",
  /**
   * Completed before (a step run again): the result as it was stored — masked by the PII policies
   * (store references and ids in a result, not personal data) — nothing sent.
   */
  Replayed = "replayed",
  /** Left pending: `reconcile` found that it happened — its result, nothing sent. */
  Reconciled = "reconciled",
  /**
   * The same call was being sent by this instance (two tool calls, two branches): its outcome,
   * shared — nothing sent again.
   */
  Joined = "joined",
}

/**
 * The application's calls that leave the system (#505): a core service a component injects
 * (`deps: [ExecutionContext, OutboundCalls]`), over the listed `OutboundCallRepository`.
 */
@Injectable({ deps: [OutboundCallRepository, OutboundCallSettings, Logger, Clock] })
export class OutboundCalls {
  /** The calls this instance is making now, by key: a second send of one meanwhile joins it. */
  readonly #live = new Map<string, LiveCall>();
  /** The attempt owners it is sending under now. */
  readonly #owners = new Set<string>();

  constructor(
    private readonly repository: OutboundCallRepository,
    private readonly settings: OutboundCallSettings,
    // the instance's log (#508), names and ids only — said by whoever builds it (#825), never silent by default
    private readonly logger: Logger,
    // the application's clock (#825): a call's attempt and its key's age, never the wall clock by default
    private readonly clock: Clock,
  ) {
    // #825: said by whoever builds it — a JavaScript caller's missing logger or clock is refused
    // (an object: `agboss check` builds the contracts' own classes, never called)
    const given: readonly unknown[] = [logger, clock];
    if (given.some((part) => typeof part !== "object" || part === null))
      throw new TypeError(
        "new OutboundCalls(repository, settings, logger, clock): a Logger and a Clock are required",
      );
  }

  /**
   * Sends the call of `key` (`effectKeyOf(executionContext, name)`) at most once per
   * outcome: completed → its stored result (`Replayed`); left pending — a crash before the answer,
   * an error of unknown outcome (#657) — → `reconcile` decides, a `KeyReplay`'s `notSent()` refused
   * past its `keyRetention` (#658); failed for certain (`isDefiniteFailure`) → sent again with the
   * same key; none → recorded, then sent; answered after a newer attempt took it over →
   * `OutboundCallSupersededError` (#795). A zombie's call, or one whose `notSent` is not one
   * (`InvalidNotSentTrustError`, #795), is refused before anything is recorded or sent.
   */
  async send<TRequest, TResult>(
    key: EffectKey | OutboundCallKey,
    options: OutboundCallSendOptions<TRequest, TResult>,
  ): Promise<OutboundCallOutcome<TResult>> {
    // a key built by hand is checked as effectKeyOf checks it (#508, #538): nothing recorded or sent
    assertEffectName(key.name);
    assertBusinessKey(key);
    // #825: a key effectKeyOf made, and a call's fingerprint is its request — never None
    callKeyErrorOf(key);
    // #795: how far a notSent() is trusted, said and valid — a JavaScript caller's too; the
    // checked copy is the one the protocol reads (`options` as given is the caller's, live)
    const { notSent, ...given } = options; // read once: a getter is never asked again
    const checked = { ...given, notSent: checkedNotSentTrust(key.name, notSent) };
    const { sendOutboundCall } = await lazyLoad(import("./outbound-call-protocol.js"));
    const { repository, settings } = this;
    const live = this.#live;
    const parts = {
      repository,
      settings,
      live,
      owners: this.#owners,
      log: frameworkLogOf(this.logger, this.clock),
      clock: this.clock,
    };
    return sendOutboundCall(parts, key, checked);
  }
}

// #825: a component that reaches OutboundCalls can send under a business key
markBusinessKeyWriter(OutboundCalls);

/**
 * An intent left pending could not be reconciled (#505): `reconcile` said `unknown`, threw (its
 * error the `cause`), gave no verdict, or said `notSent()` for a key past its `KeyReplay`'s
 * `keyRetention` (#658: a resend could be a new call). Nothing was sent; the intent stays `Pending`, listed by
 * `app.pendingOutboundCallsOf` for an operator. A `StepFailedError`: `.onError(…)` may take it.
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
      `outbound call "${name}" (${operation} on ${target}, key ${idempotencyKey}) is left pending and could not be reconciled: ${reason} — nothing was sent; an operator decides (app.pendingOutboundCallsOf)`,
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

/**
 * Another call holds the key's intent and has not ended (#505, #508): recorded by another instance
 * at the same moment, moved to a new attempt first, or — under a business key — pending under a
 * lease another instance holds. Nothing was sent: two callers never race on one payment. A
 * `StepFailedError`: `.onError(…)` or a retry policy decides; the next attempt finds what that call
 * left.
 */
export class OutboundCallInFlightError extends StepFailedError {
  static override readonly code: string = "outbound-call.in-flight";
  override name = "OutboundCallInFlightError";
  readonly call: string;
  readonly target: string;
  readonly operation: string;

  constructor(options: OutboundCallInFlightErrorOptions) {
    const { name, target, operation } = options;
    super(
      `outbound call "${name}" (${operation} on ${target}) is already in flight: another call holds its key and has not ended — nothing was sent`,
      [],
      undefined,
      stepCoordinatesOf(name, ComponentKind.Action),
      { call: name, target, operation },
    );
    this.call = name;
    this.target = target;
    this.operation = operation;
  }
}

/**
 * A completed call whose result could not be stored (#508: above `maxPayloadSize`, refused by the
 * mask) was found again: the call happened — its intent is `Completed`, nothing is sent again — but
 * there is no result to replay. A `StepFailedError`: `.onError(…)` decides; the other system has
 * the result (`reason`: the code of what kept it from being stored).
 */
export class OutboundCallResultNotStoredError extends StepFailedError {
  static override readonly code: string = "outbound-call.result-not-stored";
  override name = "OutboundCallResultNotStoredError";
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly reason: string;

  constructor(options: OutboundCallInFlightErrorOptions, reason: string) {
    const { name, target, operation } = options;
    super(
      `outbound call "${name}" (${operation} on ${target}) happened, but its result was not stored (${reason}): there is nothing to replay — nothing was sent again; read the result from ${target}`,
      [],
      undefined,
      stepCoordinatesOf(name, ComponentKind.Action),
      { call: name, target, operation, reason },
    );
    this.call = name;
    this.target = target;
    this.operation = operation;
    this.reason = reason;
  }
}
