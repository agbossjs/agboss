import { minutes } from "../../units/index.js";

/**
 * The slowdown after a 429 (#266, AIMD — additive increase, multiplicative decrease, no setting):
 * an instance's effective `maxConcurrentCalls` halves on a 429 and grows back by one per minute
 * without a 429. Per instance; the hard cap stays shared through `RateLimitRepository`.
 */

/** A lowered level: how many calls it allowed when it was set, and when (the clock's milliseconds). */
export interface ConcurrencyLevel {
  readonly lowered: number;
  readonly since: number;
}

const STEP = minutes(1);

/** The calls in flight the instance allows now: the lowered level plus one per minute since, ≤ max. */
export function concurrencyAt(
  max: number,
  level: ConcurrencyLevel | undefined,
  now: number,
): number {
  if (level === undefined) return max;
  return Math.min(max, level.lowered + Math.floor((now - level.since) / STEP));
}

/** The level after a 429 at `now`: half of what was allowed then, at least one call. */
export function halvedAt(
  max: number,
  level: ConcurrencyLevel | undefined,
  now: number,
): ConcurrencyLevel {
  return { lowered: Math.max(1, Math.floor(concurrencyAt(max, level, now) / 2)), since: now };
}
