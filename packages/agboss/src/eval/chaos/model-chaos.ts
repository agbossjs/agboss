import { ModelFailure } from "../../models/model-failure.js";
import type { ProviderFetch } from "../../models/resilient-fetch.js";
import { ModelProviderFailureError } from "../../models/transport/failure-error.js";
import type { TransportCall } from "../../models/transport/transport-carrier.js";
import {
  ChaosFailure,
  chaosProblemOf,
  type ChaosOptions,
  type EvalRunChaos,
} from "./chaos-failure.js";
import { truncatedHttpResponse, truncatedTransportResponse } from "./truncate.js";

/**
 * The injector of one run's chaos (#396 PR 6): a seeded sequence (mulberry32) decides, call by
 * call, whether the call fails and how. It wraps a provider's raw HTTP client — only its `POST`s,
 * the completions and decisions; the model lists read at start are never touched — and a transport
 * provider's `complete()`, below the attempt runner, so the retry policy, the rate limit's 429 pause
 * and the breaker see each failure as a provider's own. One per `ChaosOptions` object: every
 * workflow an application builds with the same options shares its sequence and its counts.
 */

const HTTP_TOO_MANY_REQUESTS = 429;

/** mulberry32: a small seeded generator of numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rateLimitedResponse = (): Response =>
  new Response(JSON.stringify({ error: { code: 429, message: "chaos: rate limited" } }), {
    status: HTTP_TOO_MANY_REQUESTS,
    headers: { "content-type": "application/json" },
  });

const timeoutError = (): Error =>
  new DOMException("chaos: the model call timed out", "TimeoutError");

const isPost = (input: Parameters<typeof fetch>[0], init: RequestInit | undefined): boolean =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === "POST";

export class ModelChaos {
  private readonly random: () => number;
  private seen = 0;
  private readonly counts: Record<ChaosFailure, number> = {
    [ChaosFailure.RateLimited]: 0,
    [ChaosFailure.Timeout]: 0,
    [ChaosFailure.TruncatedResponse]: 0,
  };

  constructor(
    readonly options: ChaosOptions,
    random?: () => number,
  ) {
    const problem = chaosProblemOf(options);
    if (problem !== undefined) throw new RangeError(problem);
    this.random = random ?? seeded(options.seed);
  }

  /** The next call's failure, or undefined when it goes through. */
  next(): ChaosFailure | undefined {
    this.seen += 1;
    if (this.random() >= this.options.rate) return undefined;
    const { failures } = this.options;
    return failures[Math.floor(this.random() * failures.length)];
  }

  private count(failure: ChaosFailure): void {
    this.counts[failure] += 1;
  }

  /** A provider's HTTP client with chaos in its `POST`s. */
  fetchOf(send: ProviderFetch): ProviderFetch {
    return async (input, init) => {
      if (!isPost(input, init)) return send(input, init);
      const failure = this.next();
      if (failure === ChaosFailure.RateLimited) {
        this.count(failure);
        return rateLimitedResponse();
      }
      if (failure === ChaosFailure.Timeout) {
        this.count(failure);
        throw timeoutError();
      }
      const response = await send(input, init);
      if (failure === undefined) return response;
      const truncated = await truncatedHttpResponse(response);
      if (truncated === undefined) return response;
      this.count(failure);
      return truncated;
    };
  }

  /** A transport provider's `complete()` with chaos. */
  completeOf(complete: TransportCall): TransportCall {
    return async (request) => {
      const failure = this.next();
      if (failure === ChaosFailure.RateLimited || failure === ChaosFailure.Timeout) {
        this.count(failure);
        const modelFailure =
          failure === ChaosFailure.RateLimited ? ModelFailure.RateLimited : ModelFailure.Timeout;
        throw new ModelProviderFailureError(modelFailure);
      }
      const answer = await complete(request);
      if (failure === undefined) return answer;
      this.count(failure);
      return truncatedTransportResponse(answer);
    };
  }

  /** What it did, for the run artifact. */
  summary(): EvalRunChaos {
    return { ...this.options, calls: this.seen, injected: { ...this.counts } };
  }
}

const injectors = new WeakMap<ChaosOptions, ModelChaos>();

/** The one injector of `options` (made on first use). */
export function modelChaosOf(options: ChaosOptions): ModelChaos {
  const found = injectors.get(options);
  if (found !== undefined) return found;
  const made = new ModelChaos(options);
  injectors.set(options, made);
  return made;
}
