import { systemClock, type Clock } from "../infrastructure/clock.js";
import { waitOf } from "../infrastructure/clock-timeout.js";
import type { Milliseconds } from "../units/index.js";
import { attemptOnce, type Attempt, type ProviderFetch } from "./calls/model-call.js";
import type { ProviderGate } from "./calls/provider-gate.js";
import type { ModelCost } from "./cost.js";
import { fallbackBody, markedFallbackResponse } from "./fallback.js";
import { ModelCallError, type CircuitBreaker } from "./circuit-breaker.js";
import { ModelFailure, retryAfterOf } from "./model-failure.js";
import { delayBefore, isRetried, longestWaitOf, type RetryPolicy } from "./retry-policy.js";

export type { ProviderFetch } from "./calls/model-call.js";

/**
 * Where calls go while the breaker is open: the fallback provider's base URL, key and client, its
 * model for each of the primary's (`models`) and how its calls are priced (`cost`).
 */
export interface FallbackTarget {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly fetch: ProviderFetch;
  readonly models: Readonly<Record<string, string>>;
  readonly cost: ModelCost;
}

/** Everything a provider's client needs besides the request; the application's clock, random for tests. */
export interface ResilienceOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly timeout: Milliseconds;
  readonly retryPolicy: RetryPolicy;
  /** The provider's breaker (its state in the application's `RateLimitRepository`); none = never open. */
  readonly breaker?: CircuitBreaker;
  /** The provider's `rateLimitPolicy` in this instance; none = no limit. */
  readonly gate?: ProviderGate;
  readonly fallback?: FallbackTarget;
  /** The timeout, the waits between attempts and `Retry-After` run on it (default: the system's). */
  readonly clock?: Clock;
  readonly random?: () => number;
}

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * The same request to the fallback: its base URL, its key and its model in place of the
 * provider's; its answer is marked with that model and priced by the fallback's own table.
 */
async function toFallback(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: ResilienceOptions,
  fallback: FallbackTarget,
): Promise<Response> {
  const url = urlOf(input).replace(options.baseUrl, fallback.baseUrl);
  const headers = new Headers(init?.headers);
  if (fallback.apiKey === undefined) headers.delete("authorization");
  else headers.set("authorization", `Bearer ${fallback.apiKey}`);
  const { body, model } = fallbackBody(init?.body, fallback.models);
  const response = await fallback.fetch(url, { ...init, headers, body });
  return markedFallbackResponse(response, model, fallback.cost);
}

/** `Retry-After` of a 429 or 5xx answer, in milliseconds; `undefined` when absent. */
const retryAfterIn = (attempt: Attempt, clock: Clock): number | undefined =>
  attempt.kind === "answered" ? retryAfterOf(attempt.response, clock.now().getTime()) : undefined;

/** How long to wait before the next attempt; `undefined` = stop (not retried, or Retry-After too long). */
function waitBefore(
  attempt: Attempt,
  tries: number,
  options: ResilienceOptions,
  clock: Clock,
): number | undefined {
  const failure = attempt.failure;
  if (failure === undefined || !isRetried(options.retryPolicy, failure, tries)) return undefined;
  const planned = delayBefore(options.retryPolicy, tries, options.random ?? Math.random);
  const retryAfter = retryAfterIn(attempt, clock);
  if (retryAfter === undefined) return planned;
  return retryAfter > longestWaitOf(options.retryPolicy)
    ? undefined
    : Math.max(planned, retryAfter);
}

/** A 429 pauses the provider's whole queue for `Retry-After`, else the retry policy's next delay. */
async function slowDownOn429(
  attempt: Attempt,
  tries: number,
  options: ResilienceOptions,
  clock: Clock,
): Promise<void> {
  if (options.gate === undefined || attempt.failure !== ModelFailure.RateLimited) return;
  const pause =
    retryAfterIn(attempt, clock) ??
    delayBefore(options.retryPolicy, tries, options.random ?? Math.random);
  await options.gate.slowDown(waitOf(pause));
}

/** While the breaker is open: the fallback, else fail fast with `model.circuit-open`. */
async function whileOpen(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  options: ResilienceOptions,
): Promise<Response> {
  if (options.fallback !== undefined) return toFallback(input, init, options, options.fallback);
  throw new ModelCallError(
    "model.circuit-open",
    options.provider,
    `${options.provider} is failing; calls are paused`,
  );
}

/** What an attempt's end means: the answer to give, the error to throw, or a wait and a retry. */
type AttemptOutcome =
  | { readonly kind: "answer"; readonly response: Response }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "retry"; readonly wait: number };

/** The end of attempt number `tries`: the breaker told, a 429 slowing the provider down. */
async function outcomeOf(
  attempt: Attempt,
  tries: number,
  options: ResilienceOptions,
  clock: Clock,
): Promise<AttemptOutcome> {
  if (attempt.kind === "answered" && attempt.failure === undefined) {
    await options.breaker?.recordSuccess();
    return { kind: "answer", response: attempt.response };
  }
  await slowDownOn429(attempt, tries, options, clock);
  const wait = waitBefore(attempt, tries, options, clock);
  if (wait === undefined) {
    await options.breaker?.recordFailure();
    return attempt.kind === "threw"
      ? { kind: "failed", error: attempt.error }
      : { kind: "answer", response: attempt.response };
  }
  if (attempt.kind === "answered") await attempt.response.body?.cancel();
  return { kind: "retry", wait };
}

/**
 * A provider's client: each call is tried under the retry policy (only the listed failures,
 * `Retry-After` honoured) as one call — retries are not separate attempts and are not paid twice;
 * each attempt waits for room under the rate limit, the waits between them hold none; a 429 slows
 * the whole provider down; the breaker counts failed calls and, open, sends calls to the fallback
 * or fails fast.
 */
export function resilientFetch(options: ResilienceOptions, send: ProviderFetch): ProviderFetch {
  const clock = options.clock ?? systemClock;
  const limits = { gate: options.gate, timeout: options.timeout, clock };
  return async (input, init) => {
    if ((await options.breaker?.isOpen()) === true) return whileOpen(input, init, options);
    for (let tries = 1; ; tries++) {
      const attempt = await attemptOnce(send, input, init, limits);
      const outcome = await outcomeOf(attempt, tries, options, clock);
      if (outcome.kind === "answer") return outcome.response;
      if (outcome.kind === "failed") throw outcome.error;
      await clock.sleep(waitOf(outcome.wait));
    }
  };
}
