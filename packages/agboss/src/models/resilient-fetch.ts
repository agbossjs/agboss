import { systemClock, type Clock } from "../infrastructure/clock.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { readAsStream } from "./calls/json-as-stream.js";
import { guardedEventStream, type Idle, type StreamEnd } from "./calls/event-stream-guard.js";
import { runModelCall, type ResilienceOptions } from "./calls/attempt-runner.js";
import type { Attempt, AttemptCarrier, AttemptLimits, ProviderFetch } from "./calls/model-call.js";
import { refusalOfResponse } from "./calls/input-refusal.js";
import { releasedAtBodyEnd } from "./calls/response-usage.js";
import {
  failureOfError,
  failureOfStatus,
  retryAfterOf,
  type ModelFailure,
} from "./model-failure.js";

export type { ProviderFetch } from "./calls/model-call.js";
export type { ResilienceOptions } from "./calls/attempt-runner.js";

const isEventStream = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

/** What a streamed call's end means to the breaker (#1005): its success or failure is told at the end. */
const toldTo =
  (breaker: CircuitBreaker | undefined) =>
  async (end: StreamEnd): Promise<void> => {
    if (end === "completed") await breaker?.recordSuccess();
    if (end === "failed") await breaker?.recordFailure();
  };

/** A streamed answer's attempt (#1005): read up to its first content, then watched to its end. */
async function streamedAttempt(
  response: Response,
  caller: AbortSignal | null | undefined,
  breaker: CircuitBreaker | undefined,
  idle: Idle,
): Promise<Attempt<Response>> {
  const guarded = await guardedEventStream(response, {
    settle: toldTo(breaker),
    aborted: () => caller?.aborted === true,
    idle,
  });
  if (guarded.failure !== undefined) {
    return { kind: "answered", answer: guarded.response, failure: guarded.failure };
  }
  return guarded.watched
    ? { kind: "answered", answer: guarded.response, settledAtEnd: true }
    : { kind: "answered", answer: guarded.response };
}

/** What a signal aborted with, as an error (a `TimeoutError` stays the one it is). */
const abortErrorOf = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("the request was aborted");

/** `promise`, or what `signal` aborted with, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortErrorOf(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortErrorOf(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * The answer with its body read whole, under `signal` (the attempt's timeout and the caller's own):
 * a body that stalls fails the attempt as a timeout. A body-less answer is as it is.
 */
async function bufferedWithin(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.body === null) return response;
  try {
    const bytes = await untilAborted(response.arrayBuffer(), signal);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const { status, statusText } = response;
    return new Response(bytes, { status, statusText, headers });
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
}

/** What an answer is to the attempt: its failure (and `Retry-After`), a streamed body watched, or a plain answer. */
async function outcomeOf(
  response: Response,
  failure: ModelFailure | undefined,
  caller: AbortSignal | null | undefined,
  clock: Clock,
  breaker: CircuitBreaker | undefined,
  limits: AttemptLimits,
  signal: AbortSignal,
): Promise<Attempt<Response>> {
  if (failure === undefined && isEventStream(response)) {
    return await streamedAttempt(response, caller, breaker, {
      clock: limits.clock,
      timeout: limits.timeout,
    });
  }
  // a plain answer's body is read here, under the attempt's timeout: a stall after the headers
  // times the attempt out like one before them, and is retried as such (#1125)
  if (failure === undefined)
    return { kind: "answered", answer: await bufferedWithin(response, signal) };
  const retryAfter = retryAfterOf(response, clock.now().getTime());
  return retryAfter === undefined
    ? { kind: "answered", answer: response, failure }
    : { kind: "answered", answer: response, failure, retryAfter };
}

/**
 * A response that is no failure: the answer, unless it is a 4xx that says the model cannot take an
 * input - no failure of the provider either, but a refusal that is never retried (#899).
 */
async function refusedBy(
  response: Response,
  provider: string,
  init: RequestInit | undefined,
): Promise<Attempt<Response> | undefined> {
  const body = typeof init?.body === "string" ? init.body : undefined;
  const refused = await refusalOfResponse(response, { provider, body });
  if (refused === undefined) return undefined;
  await response.body?.cancel();
  return { kind: "threw", error: refused, isRejected: true };
}

/**
 * One HTTP request as the attempts' carrier: its status says the failure, its headers `Retry-After`;
 * a streamed answer (#1005) is read up to its first content — an `{error}` there fails the attempt
 * like the same status — and its end tells the breaker.
 */
function httpCarrier(
  provider: string,
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  clock: Clock,
  breaker: CircuitBreaker | undefined,
): AttemptCarrier<Response> {
  return {
    send: async (signal, limits): Promise<Attempt<Response>> => {
      try {
        const sent = await send(input, { ...init, signal });
        const failure = failureOfStatus(sent.status);
        if (failure === undefined) {
          const refused = await refusedBy(sent, provider, init);
          if (refused !== undefined) return refused;
        }
        // a streamed request answered 200 without events (#1049): JSON is told as a stream
        const response = failure === undefined ? await readAsStream(sent, init) : sent;
        return await outcomeOf(response, failure, init?.signal, clock, breaker, limits, signal);
      } catch (error) {
        if (init?.signal?.aborted === true) throw error;
        return { kind: "threw", error, failure: failureOfError(error) };
      }
    },
    hold: (response, release) => releasedAtBodyEnd(response, release),
    drop: async (response) => {
      await response.body?.cancel();
    },
  };
}

/**
 * A provider's HTTP client: every request through the one attempt runner (`runModelCall`) — the
 * retry policy, the rate limit and its 429 pause, the breaker.
 */
export function resilientFetch(options: ResilienceOptions, send: ProviderFetch): ProviderFetch {
  const clock = options.clock ?? systemClock;
  return (input, init) =>
    runModelCall(
      options,
      httpCarrier(options.provider, send, input, init, clock, options.breaker),
      init?.signal,
    );
}
