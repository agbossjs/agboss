import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import type { Milliseconds } from "../units/index.js";
import { ModelFailure } from "./model-failure.js";
import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";

/** How the wait between attempts grows. */
export enum Backoff {
  Exponential = "exponential",
  Fixed = "fixed",
}

/**
 * `RetryPolicy.exponential({ … })`: the wait doubles from `initialDelay` up to `maxDelay`; each at
 * most 24 hours (`RetryPolicyError`, #1141).
 */
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

/** What a provider does when a call fails: typed, every field required. Omitted: no retries. */
export type RetryPolicy =
  | ({ readonly backoff: Backoff.Exponential } & ExponentialRetryOptions)
  | ({ readonly backoff: Backoff.Fixed } & FixedRetryOptions);

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

/** A retry's wait is a timer: above `MAX_TIMEOUT` it would fire at once (#1141). */
const checkDelay = (field: string, delay: number): void => {
  const problem = timerProblemOf(field, delay, MAX_TIMEOUT);
  if (problem !== undefined) throw new RetryPolicyError({ message: problem });
};

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
    checkDelay("initialDelay", options.initialDelay);
    checkDelay("maxDelay", options.maxDelay);
    if (options.maxDelay < options.initialDelay) {
      throw new RetryPolicyError({ message: "maxDelay must not be shorter than initialDelay" });
    }
    return Object.freeze({ backoff: Backoff.Exponential, ...options });
  },
  fixed(options: FixedRetryOptions): RetryPolicy {
    checkAttempts(options.maxAttempts);
    checkDelay("delay", options.delay);
    return Object.freeze({ backoff: Backoff.Fixed, ...options });
  },
};

/** Whether a failure after `attempt` attempts (1 = the first) is tried again. */
export function isRetried(
  policy: RetryPolicy | undefined,
  failure: ModelFailure,
  attempt: number,
): boolean {
  if (policy === undefined) return false;
  return attempt < policy.maxAttempts && policy.retryOn.includes(failure);
}

/** The longest wait the policy allows: a longer `Retry-After` ends the retries. */
export function longestWaitOf(policy: RetryPolicy | undefined): number {
  if (policy === undefined) return 0;
  switch (policy.backoff) {
    case Backoff.Exponential:
      return policy.maxDelay;
    case Backoff.Fixed:
      return policy.delay;
  }
}

/** The wait before retry number `retry` (1 = the first retry); `random` ∈ [0, 1) for the jitter. */
export function delayBefore(
  policy: RetryPolicy | undefined,
  retry: number,
  random: () => number,
): number {
  if (policy === undefined) return 0;
  switch (policy.backoff) {
    case Backoff.Exponential: {
      const grown = Math.min(policy.maxDelay, policy.initialDelay * 2 ** (retry - 1));
      return policy.jitter ? grown / 2 + (grown / 2) * random() : grown;
    }
    case Backoff.Fixed:
      return policy.delay;
  }
}

/** Timeouts, rate limits and server errors: what a provider usually retries. */
export const TRANSIENT_FAILURES: readonly ModelFailure[] = [
  ModelFailure.Timeout,
  ModelFailure.RateLimited,
  ModelFailure.ServerError,
];
