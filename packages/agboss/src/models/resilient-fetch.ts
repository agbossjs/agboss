import { systemClock, type Clock } from "../infrastructure/clock.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { eventStreamOfJson, wantsStream } from "./calls/json-as-stream.js";
import { guardedEventStream, type StreamEnd } from "./calls/event-stream-guard.js";
import { runModelCall, type ResilienceOptions } from "./calls/attempt-runner.js";
import type { Attempt, AttemptCarrier, ProviderFetch } from "./calls/model-call.js";
import { releasedAtBodyEnd } from "./calls/response-usage.js";
import { failureOfError, failureOfStatus, retryAfterOf } from "./model-failure.js";

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
): Promise<Attempt<Response>> {
  const guarded = await guardedEventStream(response, {
    settle: toldTo(breaker),
    aborted: () => caller?.aborted === true,
  });
  if (guarded.failure !== undefined) {
    return { kind: "answered", answer: guarded.response, failure: guarded.failure };
  }
  return guarded.watched
    ? { kind: "answered", answer: guarded.response, settledAtEnd: true }
    : { kind: "answered", answer: guarded.response };
}

/**
 * One HTTP request as the attempts' carrier: its status says the failure, its headers `Retry-After`;
 * a streamed answer (#1005) is read up to its first content — an `{error}` there fails the attempt
 * like the same status — and its end tells the breaker.
 */
function httpCarrier(
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  clock: Clock,
  breaker: CircuitBreaker | undefined,
): AttemptCarrier<Response> {
  return {
    send: async (signal): Promise<Attempt<Response>> => {
      try {
        const sent = await send(input, { ...init, signal });
        const failure = failureOfStatus(sent.status);
        // a streamed request answered 200 without events (#1049): JSON is told as a stream
        const response =
          failure === undefined && sent.ok && wantsStream(init) && !isEventStream(sent)
            ? await eventStreamOfJson(sent)
            : sent;
        if (failure === undefined && isEventStream(response)) {
          return await streamedAttempt(response, init?.signal, breaker);
        }
        if (failure === undefined) return { kind: "answered", answer: response };
        const retryAfter = retryAfterOf(response, clock.now().getTime());
        return retryAfter === undefined
          ? { kind: "answered", answer: response, failure }
          : { kind: "answered", answer: response, failure, retryAfter };
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
    runModelCall(options, httpCarrier(send, input, init, clock, options.breaker), init?.signal);
}
