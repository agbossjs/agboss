/**
 * A count limit (`maxVisits`, `maxToolCalls`, `maxRetries`) is a whole number from 0 (#1373). Anything
 * else — `NaN`, a negative or fractional number, a string, an object, `null` — reaches the run from
 * untyped code or parsed JSON; a `NaN` bound makes every comparison false, so nothing would ever stop
 * the loop it was written to stop. Assembly refuses such a value (`[limits.count-invalid]` and its
 * kin); this module is what the build analysis and the run time share, so that both read it alike and
 * fail closed: a value that is no count is a bound of 0, never a missing one.
 */

/** `Number.isInteger` as a type predicate: it is false for anything that is no number, so the guard narrows with no `typeof` term. */
const isInteger = (value: unknown): value is number => Number.isInteger(value);

/** `Number.isFinite` as a type predicate: false for anything that is no number, so a guard needs no `typeof` term. */
export const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

/** Whether `value` is a whole number from 0: a count a limit can hold. */
export const isCountLimit = (value: unknown): value is number => isInteger(value) && value >= 0;

/**
 * The bound a limit sets: none (`undefined`) is `Infinity`, a count is itself, and anything that is
 * no count — `null` included (#1365) — is 0, so the first visit, call or retry it would allow is refused.
 */
export const countBoundOf = (value: unknown): number =>
  value === undefined ? Number.POSITIVE_INFINITY : isCountLimit(value) ? value : 0;

/**
 * A limit's value as a message names it, without ever quoting text: a number is printed, anything else
 * only by its kind (what a handler or a parsed file gave may be a user's or a model's text).
 */
export function shownLimit(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return String(value);
  return `a${typeof value === "object" ? "n" : ""} ${typeof value}`;
}
