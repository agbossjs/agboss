import type { Milliseconds, Ttl } from "../units/index.js";
import { invalidRecoveryError } from "./outbound-call-errors.js";
import type { OutboundCallLookup, OutboundCallNotSent } from "./outbound-call-types.js";
import { isOutboundRecovery, Reconciliation, type OutboundRecovery } from "./outbound-recovery.js";

/**
 * The parts of the outbound-call contract that fail closed (#795, #1317): how far a resend is
 * trusted — declared on every `sendOnce` by its `recovery`, checked before anything is recorded or
 * sent — and the key a call is made under.
 */

/**
 * How far a `notExecuted()` is trusted (#795): every `sendOnce` says it through its `recovery`, so a
 * forgotten line is a compile error, never a resend of an expired key. Internal: the public words
 * are `OutboundRecovery.replayWithin`, `.permanentLookup` and `.lookupWithin`.
 */
export enum NotSentTrust {
  /** The lookup reads a record the other system keeps for good: a `notExecuted()` is the truth at any age. */
  Lookup = "lookup",
  /** A `notExecuted()` relies on the other system replaying the key (#658): sent again only while the key is young enough. */
  KeyReplay = "key-replay",
}

/** A JavaScript caller's value, for a refusal's text: never a throw (a null-prototype object). */
function shown(value: unknown): string {
  return typeof value === "object" && value !== null ? "an object" : String(value);
}

/** Why a window is not one, or `undefined` when it is. */
function windowProblemOf(window: unknown): string | undefined {
  // `Number.isFinite` is false for anything that is no number
  return Number.isFinite(window) && (window as number) > 0
    ? undefined
    : `the key window is ${shown(window)}, not a positive, finite duration`;
}

/** Why a key window does not fit the call's `timeout` and `ttl`, or `undefined` when it does. */
function windowProblemOfCall(
  window: Milliseconds,
  limits: { readonly timeout: Milliseconds; readonly ttl: Milliseconds | Ttl },
): string | undefined {
  const { ttl, timeout } = limits;
  if (windowProblemOf(window) !== undefined) return windowProblemOf(window);
  if (window <= timeout)
    return `the key window (${String(window)} ms) is not above the call's timeout (${String(timeout)} ms): a crash could never be reconciled inside it`;
  // a ttl that is `Ttl.Forever` is no number and below nothing
  return (ttl as number) < window
    ? `the call's ttl (${String(ttl)} ms) is below the key window (${String(window)} ms)`
    : undefined;
}

/** What a call's recovery is run as, once checked. */
export interface CheckedRecovery<TResult> {
  readonly notSent: OutboundCallNotSent;
  readonly reconcile: (
    lookup: OutboundCallLookup,
  ) => Promise<Reconciliation<TResult>> | Reconciliation<TResult>;
}

/**
 * `recovery` as checked — a frozen copy, so a getter or a shared object changed later is never read
 * again — or `OutboundCallError.InvalidRecovery` unless it is one built by `OutboundRecovery`, its
 * window is a positive duration above the call's `timeout` (a crash reconciliation is never
 * mathematically impossible) and the call's `ttl` keeps the rows at least as long as the window.
 */
export function checkedRecovery<TResult>(
  call: string,
  recovery: OutboundRecovery<TResult>,
  limits: { readonly timeout: Milliseconds; readonly ttl: Milliseconds | Ttl },
): CheckedRecovery<TResult> {
  const given: unknown = recovery;
  if (!isOutboundRecovery(given))
    throw invalidRecoveryError(call, `recovery is ${shown(given)}, not one OutboundRecovery made`);
  if (recovery.kind === "permanent-lookup")
    return {
      notSent: Object.freeze({ trust: NotSentTrust.Lookup }),
      reconcile: recovery.reconcile,
    };
  const window: Milliseconds = recovery.keyTtl ?? (0 as Milliseconds);
  const problem = windowProblemOfCall(window, limits);
  if (problem !== undefined) throw invalidRecoveryError(call, problem);
  const notSent = Object.freeze({
    trust: NotSentTrust.KeyReplay,
    keyRetention: window,
  }) as OutboundCallNotSent;
  return {
    notSent,
    reconcile:
      recovery.kind === "replay-within" ? () => Reconciliation.notExecuted() : recovery.reconcile,
  };
}
