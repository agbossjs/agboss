import { ConfigError } from "../core/error-families/config-errors.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import type { Milliseconds } from "../units/index.js";

/** How long a breaker stays open: always the same, or longer for each open in a row. */
export enum BreakerBackoff {
  Exponential = "exponential",
  Fixed = "fixed",
}

/**
 * `CircuitBreakerPolicy.fixed({ … })`: `failureThreshold` failed calls within `failureWindow` open
 * the breaker for `openDuration`; then `halfOpenProbes` calls at a time try the provider again.
 */
export interface FixedCircuitBreakerOptions {
  /** Failed calls within `failureWindow` that open the breaker (an integer ≥ 1). */
  readonly failureThreshold: number;
  /** The sliding window the failures are counted in. */
  readonly failureWindow: Milliseconds;
  /** How long it stays open. */
  readonly openDuration: Milliseconds;
  /** Calls let through at once after it was open to see whether the provider is back (default 1). */
  readonly halfOpenProbes?: number;
}

/**
 * `CircuitBreakerPolicy.exponential({ … })`: each open in a row lasts twice as long as the one
 * before, from `initialOpenDuration` up to `maxOpenDuration`.
 */
export interface ExponentialCircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly failureWindow: Milliseconds;
  readonly initialOpenDuration: Milliseconds;
  readonly maxOpenDuration: Milliseconds;
  /** A random part of each open duration, so instances do not probe in step. */
  readonly jitter: boolean;
  readonly halfOpenProbes?: number;
}

/**
 * Stops calling a provider that is down for a while. Its state is in `RateLimitRepository`, so
 * every instance agrees on it. After an open the breaker is half-open: `halfOpenProbes` calls go
 * through, a success closes it, a failure opens it again.
 */
export type CircuitBreakerPolicy =
  | ({ readonly backoff: BreakerBackoff.Fixed } & FixedCircuitBreakerOptions)
  | ({ readonly backoff: BreakerBackoff.Exponential } & ExponentialCircuitBreakerOptions);

const checkCount = (field: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError.CircuitBreakerPolicy({
      message: `${field} must be an integer ≥ 1, got ${String(value)}`,
    });
  }
};

/** A duration here is a timer: positive, and at most `MAX_TIMEOUT`. */
const checkDuration = (field: string, value: number): void => {
  const problem = timerProblemOf(field, value, MAX_TIMEOUT);
  if (problem !== undefined) throw new ConfigError.CircuitBreakerPolicy({ message: problem });
  if (value <= 0) {
    throw new ConfigError.CircuitBreakerPolicy({
      message: `${field} must be above 0, got ${String(value)}`,
    });
  }
};

const checkCommon = (options: Omit<FixedCircuitBreakerOptions, "openDuration">): void => {
  checkCount("failureThreshold", options.failureThreshold);
  checkDuration("failureWindow", options.failureWindow);
  if (options.halfOpenProbes !== undefined) checkCount("halfOpenProbes", options.halfOpenProbes);
};

export const CircuitBreakerPolicy = {
  fixed(options: FixedCircuitBreakerOptions): CircuitBreakerPolicy {
    checkCommon(options);
    checkDuration("openDuration", options.openDuration);
    return Object.freeze({ backoff: BreakerBackoff.Fixed, ...options });
  },
  exponential(options: ExponentialCircuitBreakerOptions): CircuitBreakerPolicy {
    checkCommon(options);
    checkDuration("initialOpenDuration", options.initialOpenDuration);
    checkDuration("maxOpenDuration", options.maxOpenDuration);
    if (options.maxOpenDuration < options.initialOpenDuration) {
      throw new ConfigError.CircuitBreakerPolicy({
        message: "maxOpenDuration must not be shorter than initialOpenDuration",
      });
    }
    return Object.freeze({ backoff: BreakerBackoff.Exponential, ...options });
  },
};

/** The probes let through at once while half-open. */
export const probesOf = (policy: CircuitBreakerPolicy): number => policy.halfOpenProbes ?? 1;

/** The shortest open: also how long a probe slot is held when its call never reports. */
export const shortestOpenOf = (policy: CircuitBreakerPolicy): Milliseconds =>
  policy.backoff === BreakerBackoff.Fixed ? policy.openDuration : policy.initialOpenDuration;

/** The longest open: how far back the opens in a row are remembered (twice it). */
export const longestOpenOf = (policy: CircuitBreakerPolicy): Milliseconds =>
  policy.backoff === BreakerBackoff.Fixed ? policy.openDuration : policy.maxOpenDuration;

/** How long open number `streak` in a row lasts (1 = the first); `random` ∈ [0, 1) for the jitter. */
export function openDurationOf(
  policy: CircuitBreakerPolicy,
  streak: number,
  random: () => number,
): number {
  if (policy.backoff === BreakerBackoff.Fixed) return policy.openDuration;
  const grown = Math.min(policy.maxOpenDuration, policy.initialOpenDuration * 2 ** (streak - 1));
  return policy.jitter ? grown / 2 + (grown / 2) * random() : grown;
}
