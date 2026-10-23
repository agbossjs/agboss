import { systemClock, type Clock } from "../../infrastructure/clock.js";
import { waitOf } from "../../infrastructure/clock-timeout.js";
import type { Milliseconds } from "../../units/index.js";
import { ModelCallError, type CircuitBreaker } from "../circuit-breaker.js";
import { ModelFailure } from "../model-failure.js";
import { delayBefore, isRetried, longestWaitOf, type RetryPolicy } from "../retry-policy.js";
import { attemptOnce, type Attempt, type AttemptCarrier } from "./model-call.js";
import type { ProviderGate } from "./provider-gate.js";

/**
 * The one runner of a model call's attempts (#266, #385), shared by HTTP and transport providers:
 * each call is tried under the retry policy (only the listed failures, `Retry-After` honoured) as
 * one call — retries are not separate attempts and are not paid twice; each attempt waits for room
 * under the rate limit, the waits between them hold none; a 429 slows the whole provider down; the
 * breaker counts failed calls and, open, fails fast with `model.circuit-open` (its fallback is the
 * chat model's, `FallbackChatModel`).
 */

/** Everything a provider's calls run under besides the request; the application's clock, random for tests. */
export interface ResilienceOptions {
  readonly provider: string;
  readonly timeout: Milliseconds;
  readonly retryPolicy: RetryPolicy;
  /** The provider's breaker (its state in the application's `RateLimitRepository`); none = never open. */
  readonly breaker?: CircuitBreaker;
  /** The provider's `rateLimitPolicy` in this instance; none = no limit. */
  readonly gate?: ProviderGate;
  /** The timeout, the waits between attempts and `Retry-After` run on it (default: the system's). */
  readonly clock?: Clock;
  readonly random?: () => number;
}

/** The error of a call to a provider whose breaker is open. */
const circuitOpenError = (provider: string): ModelCallError =>
  new ModelCallError("model.circuit-open", provider, `${provider} is failing; calls are paused`);

/** How long to wait before the next attempt; `undefined` = stop (not retried, or Retry-After too long). */
function waitBefore<T>(
  attempt: Attempt<T>,
  tries: number,
  options: ResilienceOptions,
): number | undefined {
  const failure = attempt.failure;
  if (failure === undefined || !isRetried(options.retryPolicy, failure, tries)) return undefined;
  const planned = delayBefore(options.retryPolicy, tries, options.random ?? Math.random);
  const retryAfter = attempt.retryAfter;
  if (retryAfter === undefined) return planned;
  return retryAfter > longestWaitOf(options.retryPolicy)
    ? undefined
    : Math.max(planned, retryAfter);
}

/** A 429 pauses the provider's whole queue for `Retry-After`, else the retry policy's next delay. */
async function slowDownOn429<T>(
  attempt: Attempt<T>,
  tries: number,
  options: ResilienceOptions,
): Promise<void> {
  if (options.gate === undefined || attempt.failure !== ModelFailure.RateLimited) return;
  const pause =
    attempt.retryAfter ?? delayBefore(options.retryPolicy, tries, options.random ?? Math.random);
  await options.gate.slowDown(waitOf(pause));
}

/** What an attempt's end means: the answer to give, the error to throw, or a wait and a retry. */
type AttemptOutcome<T> =
  | { readonly kind: "answer"; readonly answer: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "retry"; readonly wait: number };

/** The end of attempt number `tries`: the breaker told, a 429 slowing the provider down. */
async function outcomeOf<T>(
  attempt: Attempt<T>,
  tries: number,
  options: ResilienceOptions,
  carrier: AttemptCarrier<T>,
): Promise<AttemptOutcome<T>> {
  if (attempt.kind === "answered" && attempt.failure === undefined) {
    await options.breaker?.recordSuccess();
    return { kind: "answer", answer: attempt.answer };
  }
  await slowDownOn429(attempt, tries, options);
  const wait = waitBefore(attempt, tries, options);
  if (wait === undefined) {
    await options.breaker?.recordFailure();
    return attempt.kind === "threw"
      ? { kind: "failed", error: attempt.error }
      : { kind: "answer", answer: attempt.answer };
  }
  if (attempt.kind === "answered") await carrier.drop(attempt.answer);
  return { kind: "retry", wait };
}

/** One call through its carrier: open breaker → `model.circuit-open`, else attempts until an end. */
export async function runModelCall<T>(
  options: ResilienceOptions,
  carrier: AttemptCarrier<T>,
  caller: AbortSignal | null | undefined,
): Promise<T> {
  const clock = options.clock ?? systemClock;
  const limits = { gate: options.gate, timeout: options.timeout, clock };
  if ((await options.breaker?.isOpen()) === true) throw circuitOpenError(options.provider);
  for (let tries = 1; ; tries++) {
    const attempt = await attemptOnce(carrier, limits, caller);
    const outcome = await outcomeOf(attempt, tries, options, carrier);
    if (outcome.kind === "answer") return outcome.answer;
    if (outcome.kind === "failed") throw outcome.error;
    await clock.sleep(waitOf(outcome.wait));
  }
}
