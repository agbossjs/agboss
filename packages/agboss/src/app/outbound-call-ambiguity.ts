import { errorRecordOf } from "../core/error-record.js";
import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";
import type { Milliseconds } from "../units/index.js";
import { fencedEnd, superseded } from "./outbound-call-endings.js";
import { maskedFailureOf, subjectOf, told, type CallRun } from "./outbound-call-parts.js";

/**
 * When the outcome of a call is not known (#657, #658), loaded with the protocol: an error `send`
 * threw is a definite failure only when the call's `isDefiniteFailure` says so — anything else
 * leaves the intent pending, for `reconcile`; and a `notSent()` is sent again only while the key is
 * younger than the other system's `keyRetention` by at least `attemptTimeout`.
 */

/**
 * Whether `error` proves the other system did not carry the call out: only a `true` from the call's
 * `isDefiniteFailure`. No predicate, any other answer, or a predicate that throws: unknown.
 */
export function isDefiniteFailureOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  error: unknown,
): boolean {
  const { isDefiniteFailure } = run.options;
  if (isDefiniteFailure === undefined) return false;
  try {
    // only `true`: a JavaScript predicate's `"yes"` or `1` is no proof
    const answer: unknown = isDefiniteFailure(error);
    return answer === true;
  } catch (thrown) {
    const { code } = errorRecordOf(thrown);
    const why = `isDefiniteFailure of outbound call "${run.key.name}" (${run.options.operation} on ${run.options.target}) threw (${code}): the error is taken as of unknown outcome`;
    run.parts.log.warn("outbound-call.classifier-threw", why, subjectOf(run));
    return false;
  }
}

/**
 * Attempt `attempt` threw an error of unknown outcome: its intent stays `Pending` — nothing
 * written, so the next call reconciles it — told `Ambiguous` and logged by its code, never its text.
 */
export function leftPending<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  error: unknown,
): void {
  told(run, OutboundCallEventOutcome.Ambiguous, [OutboundCallStatus.Pending, attempt]);
  const { code } = errorRecordOf(error);
  const { operation, target } = run.options;
  const text = `outbound call "${run.key.name}" (${operation} on ${target}) attempt ${String(attempt)} threw an error of unknown outcome (${code}): its intent stays pending, and the next call asks reconcile before anything is sent again`;
  run.parts.log.warn("outbound-call.outcome-unknown", text, subjectOf(run));
}

/** A time the store wrote, in ms since the epoch; `undefined` when it wrote none (or not a time). */
const timeOf = (text: string | undefined): number | undefined => {
  const time = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
};

/** When `found`'s attempt left pending started, on the store's clock (#658). */
export function attemptStartedAtOf(found: OutboundCallRecord): Date | undefined {
  const time = timeOf(found.attemptStartedAt);
  return time === undefined ? undefined : new Date(time);
}

/**
 * The age of `found`'s key now (#658): from its first attempt's start to the read, both on the
 * store's clock, plus what passed since `readStarted` (taken before the read) on this instance's
 * monotonic clock — never less than the true age. `undefined` without both times.
 */
export function keyAgeOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
  readStarted: number,
): Milliseconds | undefined {
  const first = timeOf(found.firstAttemptStartedAt);
  const read = timeOf(found.readAt);
  if (first === undefined || read === undefined) return undefined;
  const since = run.parts.clock.monotonicNow() - readStarted;
  return (Math.max(0, read - first) + Math.max(0, since)) as Milliseconds;
}

/**
 * Why a `notSent()` of `found` must not be sent again (#658), or `undefined` when it may: with a
 * `keyRetention`, only a key whose age plus `attemptTimeout` (how long the resend may take to
 * arrive) is below it — an age not recorded, or a retention that is not a number, refuses.
 */
export function keyRetentionRefusalOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  keyAge: Milliseconds | undefined,
): string | undefined {
  const { keyRetention, target } = run.options;
  if (keyRetention === undefined) return undefined;
  const margin = run.parts.settings.attemptTimeout;
  if (keyAge !== undefined && keyAge + margin < keyRetention) return undefined;
  const kept = `${target} keeps keys for ${String(keyRetention)} ms (keyRetention), and a resend may take ${String(margin)} ms to arrive (attemptTimeout)`;
  const age =
    keyAge === undefined
      ? "when the key was first sent is not recorded"
      : `the key was first sent ${String(Math.round(keyAge))} ms ago`;
  return `reconcile answered notSent(), but ${age}; ${kept}: a resend may be a new call, not a replay`;
}

/**
 * Attempt `attempt` threw `error`, its step not aborted: `Failed` (fenced, for its owner) only when
 * the call's `isDefiniteFailure` says the other system did not carry it out (#657); anything else
 * leaves it `Pending`, so the next call reconciles it before anything is sent again.
 */
export async function failedOrPending<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  owner: string,
  error: unknown,
): Promise<void> {
  // the other system's error, definite or not: a call joined to this one shares it
  run.answer.isAnswered = true;
  if (!isDefiniteFailureOf(run, error)) {
    leftPending(run, attempt, error);
    return;
  }
  const failure = await maskedFailureOf(run, error);
  const isFailed = () => run.parts.repository.markFailed(run.key, owner, failure);
  if (!(await fencedEnd(run, attempt, isFailed))) await superseded(run, attempt);
  else told(run, OutboundCallEventOutcome.Failed, [OutboundCallStatus.Failed, attempt]);
}
