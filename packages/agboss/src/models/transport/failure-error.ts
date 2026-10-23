import { AGBossError } from "../../core/errors.js";
import type { Milliseconds } from "../../units/index.js";
import type { ModelFailure } from "../model-failure.js";

/** What a transport's failure may add: how long the provider asks to wait, and the SDK's error. */
export interface ModelProviderFailureOptions {
  /** A 429's `Retry-After` (or the SDK's own hint): pauses the provider's whole queue that long. */
  readonly retryAfter?: Milliseconds;
  readonly cause?: unknown;
}

/**
 * Thrown by `complete(request)` (#385) to say why a call failed, as an HTTP status says it for an
 * HTTP provider: the `retryPolicy` retries the failures it lists, `ModelFailure.RateLimited` pauses
 * the provider's queue for `retryAfter` and halves its concurrency, the breaker counts it. Any
 * other error of `complete()` is not retried and counted by the breaker.
 */
export class ModelProviderFailureError extends AGBossError {
  static override readonly code: string = "model.provider-failure";
  readonly failure: ModelFailure;
  readonly retryAfter: Milliseconds | undefined;

  constructor(failure: ModelFailure, options: ModelProviderFailureOptions = {}) {
    super(
      `model.provider-failure: ${failure}`,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.failure = failure;
    this.retryAfter = options.retryAfter;
  }
}
