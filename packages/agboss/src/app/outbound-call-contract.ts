import { AGBossError } from "../core/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import type {
  OutboundCallNotSent,
  OutboundCallSupersededErrorOptions,
} from "./outbound-call-types.js";

/**
 * The parts of the outbound-call contract that fail closed (#795): how far a `notSent()` is
 * trusted — declared on every `send`, checked before anything is recorded or sent — and the error
 * of an attempt answered after a newer one took its intent over. Exported by `errors.ts` and
 * `public/infrastructure.ts`.
 */

/**
 * How far a `notSent()` of `reconcile` is trusted (#795) — every `send` says it (`notSent`), so a
 * forgotten line is a compile error, never a resend of an expired key.
 */
export enum NotSentTrust {
  /**
   * `reconcile` reads a record the other system keeps for good — its books of payments, a list of
   * refunds, a search that does not lag: a `notSent()` is the truth at any age, and sent again.
   */
  Lookup = "lookup",
  /**
   * `reconcile`'s `notSent()` relies on the other system replaying the key (#658): sent again only
   * while `lookup.keyAge` plus `attemptTimeout` is below the declared `keyRetention`.
   */
  KeyReplay = "key-replay",
}

/** A JavaScript caller's value, for a refusal's text: never a throw (a null-prototype object). */
function shown(value: unknown): string {
  return typeof value === "object" && value !== null ? "an object" : String(value);
}

/** Why a call's `notSent` is not one, or `undefined` when it is (#795). */
function notSentTrustProblemOf(notSent: unknown): string | undefined {
  if (typeof notSent !== "object" || notSent === null)
    return `notSent is ${shown(notSent)}, not a { trust }: say how far a notSent() of reconcile is trusted`;
  const { trust, keyRetention } = notSent as { trust?: unknown; keyRetention?: unknown };
  if (trust === NotSentTrust.Lookup)
    return keyRetention === undefined
      ? undefined
      : "a Lookup has no keyRetention: the record it reads does not expire";
  if (trust !== NotSentTrust.KeyReplay)
    return `notSent.trust is ${shown(trust)}, neither NotSentTrust.Lookup nor NotSentTrust.KeyReplay`;
  // Number.isFinite is false for anything but a finite number: a text, a NaN, an infinity
  const isDuration = Number.isFinite(keyRetention) && (keyRetention as number) > 0;
  return isDuration
    ? undefined
    : `a KeyReplay's keyRetention is ${shown(keyRetention)}, not a positive, finite duration`;
}

/**
 * `notSent` as checked — a frozen copy, so a getter or a shared object changed later is never read
 * again — or `InvalidNotSentTrustError` unless it is one (#795): nothing recorded or sent.
 */
export function checkedNotSentTrust(
  call: string,
  notSent: OutboundCallNotSent,
): OutboundCallNotSent {
  const problem = notSentTrustProblemOf(notSent);
  if (problem !== undefined) throw new InvalidNotSentTrustError({ call, problem });
  // the two fields as read now (a Lookup's `keyRetention` is checked to be `undefined`)
  const { trust, keyRetention } = notSent;
  return Object.freeze({ trust, keyRetention }) as OutboundCallNotSent;
}

/** What an invalid `notSent` knows: the call and what is wrong with it. */
export interface InvalidNotSentTrustErrorOptions {
  readonly call: string;
  readonly problem: string;
}

/**
 * A call's `notSent` is not one (#795): missing — a JavaScript caller —, an unknown `trust`, a
 * `KeyReplay` without a positive, finite `keyRetention`, or a `Lookup` with one. Nothing was
 * recorded or sent: the framework never guesses how far a `notSent()` is trusted.
 */
export class InvalidNotSentTrustError extends AGBossError {
  static override readonly code = "outbound-call.invalid-not-sent-trust" as const;
  override name = "InvalidNotSentTrustError";
  readonly call: string;
  readonly problem: string;

  constructor(options: InvalidNotSentTrustErrorOptions) {
    super(
      `outbound call "${options.call}" was refused: ${options.problem} — notSent: { trust: NotSentTrust.Lookup } or { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) }; nothing was recorded or sent`,
      { details: { call: options.call } },
    );
    this.call = options.call;
    this.problem = options.problem;
  }
}

/**
 * An attempt of a call was answered after a newer attempt took its intent over (#508, #795): both
 * reached the other system — one charge when it honours `call.idempotencyKey`, two when it does
 * not. The answer is not stored; the lease log and the instance's log name both attempts. A
 * `StepFailedError`, never a normal outcome: `.onError(OutboundCallSupersededError, …)` is the
 * explicit choice to go on — check the other system first.
 */
export class OutboundCallSupersededError extends StepFailedError {
  static override readonly code = "outbound-call.superseded" as const;
  override name = "OutboundCallSupersededError";
  readonly call: string;
  readonly target: string;
  readonly operation: string;
  /** The key both attempts went with (a business key's by its handle). */
  readonly idempotencyKey: string;
  /** The attempt that was answered too late. */
  readonly attempt: number;
  /** The newer attempt that took the intent over; `undefined` when the intent could not be read. */
  readonly supersededBy: number | undefined;

  /** `cause`: what the late attempt itself answered when that was an error (a definite failure). */
  constructor(options: OutboundCallSupersededErrorOptions, cause?: unknown) {
    const { name, target, operation, idempotencyKey, attempt, supersededBy } = options;
    const by =
      supersededBy === undefined
        ? "a newer attempt (which one is unknown)"
        : `attempt ${String(supersededBy)}`;
    super(
      `outbound call "${name}" (${operation} on ${target}, key ${idempotencyKey}) attempt ${String(attempt)} was answered after ${by} took its intent over: both reached ${target} — its answer is not stored; check ${target} before going on`,
      [],
      cause,
      stepCoordinatesOf(name, ComponentKind.Action),
      {
        call: name,
        target,
        operation,
        attempt,
        ...(supersededBy === undefined ? {} : { supersededBy }),
      },
    );
    this.call = name;
    this.target = target;
    this.operation = operation;
    this.idempotencyKey = idempotencyKey;
    this.attempt = attempt;
    this.supersededBy = supersededBy;
  }
}
