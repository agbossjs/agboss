import { systemClock, type Clock } from "../infrastructure/clock.js";
import { runModelCall, type ResilienceOptions } from "./calls/attempt-runner.js";
import type { Attempt, AttemptCarrier, ProviderFetch } from "./calls/model-call.js";
import { releasedAtBodyEnd } from "./calls/response-usage.js";
import { failureOfError, failureOfStatus, retryAfterOf } from "./model-failure.js";

export type { ProviderFetch } from "./calls/model-call.js";
export type { ResilienceOptions } from "./calls/attempt-runner.js";

/** One HTTP request as the attempts' carrier: its status says the failure, its headers `Retry-After`. */
function httpCarrier(
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  clock: Clock,
): AttemptCarrier<Response> {
  return {
    send: async (signal): Promise<Attempt<Response>> => {
      try {
        const response = await send(input, { ...init, signal });
        const failure = failureOfStatus(response.status);
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
    runModelCall(options, httpCarrier(send, input, init, clock), init?.signal);
}
