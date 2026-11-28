import { OutboundCallError } from "../core/error-families/effect-errors.js";
import type { Bytes } from "../units/index.js";

/**
 * The errors of a call that leaves the system (#505, #795, #1317, #1325): each one
 * `OutboundCallError.<Variant>`, made here with its own sentence — the call's name, its target and
 * operation, a key's handle; never a request, a result or a business key.
 */

/** What every call error names. */
export interface OutboundCallFacts {
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  readonly cause?: unknown;
}

/** Which part of a call is too large. */
export type OutboundCallPart = "request" | "result";

/** What is stored of a failure's text where no mask can be applied (#505): never the text. */
export const REDACTED = "[redacted]";

/**
 * Another call holds the key's intent and has not ended (#505, #508): recorded by another instance
 * at the same moment, moved to a new attempt first, or — under a business key — pending under a
 * lease another instance holds. Nothing was sent: two callers never race on one payment.
 */
export const inFlightError = (options: OutboundCallFacts): OutboundCallError.InFlight => {
  const { call, target, operation, cause } = options;
  return new OutboundCallError.InFlight({
    message: `outbound call "${call}" (${operation} on ${target}) is already in flight: another call holds its key and has not ended — nothing was sent`,
    call,
    target,
    operation,
    cause,
  });
};

/** What a superseded attempt knows (#795): the call, its key's handle and both attempts. */
export interface SupersededOptions extends OutboundCallFacts {
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly supersededBy: number | undefined;
}

/**
 * An attempt was answered after a newer attempt took its intent over (#508, #795): both reached the
 * other system. The answer is not stored; never a normal outcome — `.onError(OutboundCallError.Superseded, …)`
 * is the explicit choice to go on, after checking the other system.
 */
export const supersededError = (options: SupersededOptions): OutboundCallError.Superseded => {
  const { call, target, operation, idempotencyKey, attempt, supersededBy, cause } = options;
  const by =
    supersededBy === undefined
      ? "a newer attempt (which one is unknown)"
      : `attempt ${String(supersededBy)}`;
  return new OutboundCallError.Superseded({
    message: `outbound call "${call}" (${operation} on ${target}, key ${idempotencyKey}) attempt ${String(attempt)} was answered after ${by} took its intent over: both reached ${target} — its answer is not stored; check ${target} before going on`,
    call,
    target,
    operation,
    idempotencyKey,
    attempt,
    supersededBy,
    cause,
  });
};

/** What an unreconciled call knows: the call, its key's handle, why — never its request. */
export interface UnreconciledOptions extends OutboundCallFacts {
  readonly idempotencyKey: string;
  readonly reason: OutboundCallError.Unreconciled["reason"];
  /** What was said, masked: the lookup's own reason, the thrown error's message, the key's age. */
  readonly detail: string;
}

/** An intent left pending could not be reconciled (#505): nothing was sent; an operator decides. */
export const unreconciledError = (options: UnreconciledOptions): OutboundCallError.Unreconciled => {
  const { call, target, operation, idempotencyKey, reason, detail, cause } = options;
  return new OutboundCallError.Unreconciled({
    message: `outbound call "${call}" (${operation} on ${target}, key ${idempotencyKey}) is left pending and could not be reconciled (${reason}): ${detail} — nothing was sent; an operator decides (app.listOutboundCalls)`,
    call,
    target,
    operation,
    idempotencyKey,
    reason,
    detail,
    cause,
  });
};

/** What a completed call without a stored result knows: the call, and why it was not stored. */
export interface ResultNotStoredOptions extends OutboundCallFacts {
  readonly reason: OutboundCallError.ResultNotStored["reason"];
}

/**
 * A completed call whose result could not be stored (#508) was found again: the call happened,
 * nothing is sent again, but there is no result to replay — the other system has it.
 */
export const resultNotStoredError = (
  options: ResultNotStoredOptions,
): OutboundCallError.ResultNotStored => {
  const { call, target, operation, reason, cause } = options;
  return new OutboundCallError.ResultNotStored({
    message: `outbound call "${call}" (${operation} on ${target}) happened, but its result was not stored (${reason}): there is nothing to replay — nothing was sent again; read the result from ${target}`,
    call,
    target,
    operation,
    reason,
    cause,
  });
};

/** What a payload too large to store knows: the call, its part, its size and the limit (bytes). */
export interface PayloadTooLargeOptions {
  readonly call: string;
  readonly part: OutboundCallPart;
  readonly size: Bytes;
  readonly maxPayloadSize: Bytes;
  readonly cause?: unknown;
}

/**
 * A call's request or result is larger than its `maxPayloadSize` (default 64 KB). A request: nothing
 * was recorded or sent. A result: the call was answered, its intent stays pending.
 */
export const payloadTooLargeError = (
  options: PayloadTooLargeOptions,
): OutboundCallError.PayloadTooLarge =>
  new OutboundCallError.PayloadTooLarge({
    message: `the ${options.part} of outbound call "${options.call}" is ${String(options.size)} bytes, above its maxPayloadSize of ${String(options.maxPayloadSize)} bytes — send and store a reference, or raise maxPayloadSize of sendOnce`,
    call: options.call,
    part: options.part,
    size: options.size,
    maxPayloadSize: options.maxPayloadSize,
    cause: options.cause,
  });

/**
 * A call would have stored its request unmasked (#505, #906): the application lists PII policies,
 * but the step's frame carries no mask. Nothing was recorded or sent — the framework fails closed.
 */
export const unmaskedError = (call: string, cause?: unknown): OutboundCallError.Unmasked =>
  new OutboundCallError.Unmasked({
    message: `outbound call "${call}" was refused: the application lists PII policies, but this step has no mask to store its request with — nothing was recorded or sent`,
    call,
    cause,
  });

/**
 * A call's `recovery` is not one (#795, #1317): not built by `OutboundRecovery`, a window that is
 * not a positive duration, a window not above the call's `timeout`, or a `ttl` below the window.
 * Nothing was recorded or sent: the framework never guesses how far a resend is trusted.
 */
export const invalidRecoveryError = (
  call: string,
  problem: string,
): OutboundCallError.InvalidRecovery =>
  new OutboundCallError.InvalidRecovery({
    message: `outbound call "${call}" was refused: ${problem} — recovery: OutboundRecovery.replayWithin(hours(24)), .permanentLookup(…) or .lookupWithin(hours(24), …); nothing was recorded or sent`,
    call,
    problem,
  });
