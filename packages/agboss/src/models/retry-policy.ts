import type { Milliseconds } from "../units/index.js";
import { ModelFailure } from "./model-failure.js";
import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";

/** How the wait between attempts grows. */
export enum Backoff {
  Exponential = "exponential",
  Fixed = "fixed",
  None = "none",
}

/** `RetryPolicy.exponential({ … })`: the wait doubles from `initialDelay` up to `maxDelay`. */
export interface ExponentialRetryOptions {
  /** Attempts including the first. */
  readonly maxAttempts: number;
  readonly initialDelay: Milliseconds;
  readonly maxDelay: Milliseconds;
  /** A random part of each wait, so parallel runs do not retry in step. */
  readonly jitter: boolean;
  readonly retryOn: readonly ModelFailure[];
}

/** `RetryPolicy.fixed({ … })`: the same wait before every retry. */
export interface FixedRetryOptions {
  readonly maxAttempts: number;
  readonly delay: Milliseconds;
  readonly retryOn: readonly ModelFailure[];
}

/** What a provider does when a call fails: typed, every field required. */
export type RetryPolicy =
  | ({ readonly backoff: Backoff.Exponential } & ExponentialRetryOptions)
  | ({ readonly backoff: Backoff.Fixed } & FixedRetryOptions)
  | { readonly backoff: Backoff.None };

/**
 * A value out of range, as the platform's `RangeError`, so `catch` keeps telling it from other errors;
 * made as every framework error is (#906): `{ message, cause }`, with a literal `code`.
 */
export class RetryPolicyError extends RangeError {
  static readonly code = "config.retry-policy" as const;
  readonly code = RetryPolicyError.code;
  override name = "RetryPolicyError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

const checkAttempts = (maxAttempts: number): void => {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RetryPolicyError({
      message: `maxAttempts must be an integer ≥ 1, got ${String(maxAttempts)}`,
    });
  }
};

export const RetryPolicy = {
  exponential(options: ExponentialRetryOptions): RetryPolicy {
    checkAttempts(options.maxAttempts);
    if (options.maxDelay < options.initialDelay) {
      throw new RetryPolicyError({ message: "maxDelay must not be shorter than initialDelay" });
    }
    return Object.freeze({ backoff: Backoff.Exponential, ...options });
  },
  fixed(options: FixedRetryOptions): RetryPolicy {
    checkAttempts(options.maxAttempts);
    return Object.freeze({ backoff: Backoff.Fixed, ...options });
  },
  none(): RetryPolicy {
    return Object.freeze({ backoff: Backoff.None });
  },
};

/** Whether a failure after `attempt` attempts (1 = the first) is tried again. */
export function isRetried(policy: RetryPolicy, failure: ModelFailure, attempt: number): boolean {
  if (policy.backoff === Backoff.None) return false;
  return attempt < policy.maxAttempts && policy.retryOn.includes(failure);
}

/** The longest wait the policy allows: a longer `Retry-After` ends the retries. */
export function longestWaitOf(policy: RetryPolicy): number {
  switch (policy.backoff) {
    case Backoff.Exponential:
      return policy.maxDelay;
    case Backoff.Fixed:
      return policy.delay;
    case Backoff.None:
      return 0;
  }
}

/** The wait before retry number `retry` (1 = the first retry); `random` ∈ [0, 1) for the jitter. */
export function delayBefore(policy: RetryPolicy, retry: number, random: () => number): number {
  switch (policy.backoff) {
    case Backoff.Exponential: {
      const grown = Math.min(policy.maxDelay, policy.initialDelay * 2 ** (retry - 1));
      return policy.jitter ? grown / 2 + (grown / 2) * random() : grown;
    }
    case Backoff.Fixed:
      return policy.delay;
    case Backoff.None:
      return 0;
  }
}

/** Timeouts, rate limits and server errors: what a provider usually retries. */
export const TRANSIENT_FAILURES: readonly ModelFailure[] = [
  ModelFailure.Timeout,
  ModelFailure.RateLimited,
  ModelFailure.ServerError,
];
