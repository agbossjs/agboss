import type { Attempt, AttemptCarrier } from "../calls/model-call.js";
import { ModelFailure } from "../model-failure.js";
import { ModelProviderFailureError } from "./failure-error.js";
import type { ModelProviderRequest, ModelProviderResponse } from "./transport.js";

/** One call of a transport provider: its `complete(request)` (#385). */
export type TransportCall = (request: ModelProviderRequest) => Promise<ModelProviderResponse>;

/** Why the signal aborted, as an error. */
function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** The call, ended by `signal` too: an SDK that ignores it cannot hold the attempt past its timeout. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(reasonOf(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** The tokens an answer used (0 when it reports none it can be read by: it is checked later). */
function tokensOf(answer: ModelProviderResponse): number {
  const usage: unknown = Reflect.get(answer, "usage");
  if (typeof usage !== "object" || usage === null) return 0;
  const tokens =
    Number(Reflect.get(usage, "inputTokens")) + Number(Reflect.get(usage, "outputTokens"));
  return Number.isFinite(tokens) ? tokens : 0;
}

/** What a thrown error of `complete()` means: the failure it says, a timeout of ours, or none. */
function failedAttempt(error: unknown, signal: AbortSignal): Attempt<ModelProviderResponse> {
  if (error instanceof ModelProviderFailureError) {
    return error.retryAfter === undefined
      ? { kind: "threw", error, failure: error.failure }
      : { kind: "threw", error, failure: error.failure, retryAfter: error.retryAfter };
  }
  // the attempt's own timeout (the caller's signal did not abort): a timeout, as for HTTP
  if (signal.aborted) return { kind: "threw", error, failure: ModelFailure.Timeout };
  return { kind: "threw", error };
}

/**
 * A transport's request as the attempts' carrier: each attempt calls `complete()` with the
 * attempt's signal; its answer releases the rate-limit room at once with its real tokens.
 */
export function transportCarrier(
  complete: TransportCall,
  request: Omit<ModelProviderRequest, "signal">,
  caller: AbortSignal | undefined,
): AttemptCarrier<ModelProviderResponse> {
  return {
    send: async (signal): Promise<Attempt<ModelProviderResponse>> => {
      try {
        const answer = await untilAborted(complete({ ...request, signal }), signal);
        return { kind: "answered", answer };
      } catch (error) {
        if (caller?.aborted === true) throw error;
        return failedAttempt(error, signal);
      }
    },
    hold: (answer, release) => {
      void release(tokensOf(answer));
      return answer;
    },
    drop: () => Promise.resolve(),
  };
}
