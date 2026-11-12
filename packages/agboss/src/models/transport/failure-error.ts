import { AGBossError } from "../../core/errors.js";
import type { Milliseconds } from "../../units/index.js";
import type { ModelFailure } from "../model-failure.js";

/** What a transport's failure takes (#906): why it failed, and what it may add. */
export interface ModelProviderFailureOptions {
  /** Why the call failed, as an HTTP status says it. */
  readonly failure: ModelFailure;
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
  static override readonly code = "model.provider-failure" as const;
  declare readonly code: typeof ModelProviderFailureError.code;
  readonly failure: ModelFailure;
  readonly retryAfter: Milliseconds | undefined;

  constructor(options: ModelProviderFailureOptions) {
    const { failure, retryAfter, cause } = options;
    super(`model.provider-failure: ${failure}`, { cause });
    this.failure = failure;
    this.retryAfter = retryAfter;
  }
}
