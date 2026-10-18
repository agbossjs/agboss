import { systemClock, type Clock } from "../infrastructure/clock.js";
import { timeoutError, timeoutOn, waitOf } from "../infrastructure/clock-timeout.js";
import type { Milliseconds } from "../units/index.js";
import type { ModelCost } from "./cost.js";
import { fallbackBody, markedFallbackResponse } from "./fallback.js";
import { ModelCallError, type CircuitBreaker } from "./circuit-breaker.js";
import {
  failureOfError,
  failureOfStatus,
  retryAfterOf,
  type ModelFailure,
} from "./model-failure.js";
import { delayBefore, isRetried, longestWaitOf, type RetryPolicy } from "./retry-policy.js";

/** The HTTP client of a provider: `fetch` with its timeout, retries and circuit breaker. */
export type ProviderFetch = typeof fetch;

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
  readonly breaker: CircuitBreaker;
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

type Attempt =
  | { readonly kind: "answered"; readonly response: Response; readonly failure?: ModelFailure }
  | { readonly kind: "threw"; readonly error: unknown; readonly failure: ModelFailure };

/** One attempt under the provider's timeout on the clock (and the caller's own signal). */
async function attemptOnce(
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  timeout: { readonly delay: Milliseconds; readonly clock: Clock },
): Promise<Attempt> {
  const timer = timeoutOn(timeout.clock, timeout.delay, timeoutError);
  const signals = [timer.signal, ...(init?.signal ? [init.signal] : [])];
  try {
    const response = await send(input, { ...init, signal: AbortSignal.any(signals) });
    const failure = failureOfStatus(response.status);
    return failure === undefined
      ? { kind: "answered", response }
      : { kind: "answered", response, failure };
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    return { kind: "threw", error, failure: failureOfError(error) };
  } finally {
    timer.release();
  }
}

/** How long to wait before the next attempt; `undefined` = stop (not retried, or Retry-After too long). */
function waitBefore(
  attempt: Attempt,
  tries: number,
  options: ResilienceOptions,
): number | undefined {
  const failure = attempt.failure;
  if (failure === undefined || !isRetried(options.retryPolicy, failure, tries)) return undefined;
  const planned = delayBefore(options.retryPolicy, tries, options.random ?? Math.random);
  if (attempt.kind === "threw") return planned;
  const retryAfter = retryAfterOf(attempt.response, (options.clock ?? systemClock).now().getTime());
  if (retryAfter === undefined) return planned;
  return retryAfter > longestWaitOf(options.retryPolicy)
    ? undefined
    : Math.max(planned, retryAfter);
}

/**
 * A provider's client: each call is tried under the retry policy (only the listed failures,
 * `Retry-After` honoured) as one call — retries are not separate attempts and are not paid twice;
 * the breaker counts failed calls and, open, sends calls to the fallback or fails fast.
 */
export function resilientFetch(options: ResilienceOptions, send: ProviderFetch): ProviderFetch {
  const clock = options.clock ?? systemClock;
  return async (input, init) => {
    if (options.breaker.isOpen()) {
      if (options.fallback !== undefined) return toFallback(input, init, options, options.fallback);
      throw new ModelCallError(
        "model.circuit-open",
        options.provider,
        `${options.provider} is failing; calls are paused`,
      );
    }
    for (let tries = 1; ; tries++) {
      const attempt = await attemptOnce(send, input, init, { delay: options.timeout, clock });
      if (attempt.kind === "answered" && attempt.failure === undefined) {
        options.breaker.recordSuccess();
        return attempt.response;
      }
      const wait = waitBefore(attempt, tries, options);
      if (wait === undefined) {
        options.breaker.recordFailure();
        if (attempt.kind === "threw") throw attempt.error;
        return attempt.response;
      }
      if (attempt.kind === "answered") await attempt.response.body?.cancel();
      await clock.sleep(waitOf(wait));
    }
  };
}
