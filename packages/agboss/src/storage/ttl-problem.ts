import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { shownValueOf } from "../core/shown-value.js";
import { hours } from "../units/index.js";

/** The longest ttl: a century. Longer, `now − ttl` leaves what a `Date` holds and a sweep's removal fails. */
const MAX_TTL = hours(24 * 365 * 100);

/**
 * What is wrong with a ttl given as a duration, or `undefined`: a positive, finite number of
 * milliseconds up to a century — and, when its rows are what a fenced write relies on, above the
 * lease's 30 s, so that a late zombie or a retried write is still refused, never let through.
 */
export function ttlProblemOf(value: unknown, isAboveLease: boolean): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return `is ${shownValueOf(value)}, not a positive duration`;
  if (value > MAX_TTL)
    return `is ${String(value)} ms, above a century (${String(MAX_TTL)} ms) — a cutoff a date cannot hold`;
  if (isAboveLease && value <= EXECUTION_LEASE)
    return `is ${String(value)} ms, not above the lease's ${String(EXECUTION_LEASE)} ms`;
  return undefined;
}
