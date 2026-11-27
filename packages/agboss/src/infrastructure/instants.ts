import { StoreError } from "../core/error-families/store-errors.js";

/**
 * Comparing moments (G3, #1307): a pause's times are `Date`s in memory, and `===`, `!==` and `<` on
 * two `Date`s compare references, never instants — a compare-and-set written that way loses every time
 * (`UpdateContended` for good) or, worse, wins when it must not. Every comparison of a pause's times
 * goes through here: two `Date`s are the same instant when their milliseconds are. The texts a store
 * keeps in its raw columns and JSON are ISO 8601 (`toISOString()`), read back only in that one
 * spelling (`instantOfText`).
 */

/** Whether both name the same instant; two absent times (`undefined`) are the same. */
export const sameInstant = (a: Date | undefined, b: Date | undefined): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Whether a `Date` names an instant: an Invalid Date (`new Date(NaN)`) does not. */
export const isValidInstant = (at: Date): boolean => !Number.isNaN(at.getTime());

/**
 * Refuses an Invalid Date a store was handed to keep (or a rule to apply): it would be written as
 * `null` in JSON or throw in `toISOString()`, and read back as a poison row or compared as never
 * equal, never before, never after. A `StoreError.UnreadableRecord` (the one `StoreError` a store
 * raises for a time it cannot keep or read back) naming the `field`, never the value; nothing is
 * written. An absent time (`undefined`) is fine: the caller decides whether one is required.
 */
export const assertValidInstant = (at: Date | undefined, field: string, record = "pause"): void => {
  if (at !== undefined && !isValidInstant(at))
    throw new StoreError.UnreadableRecord({ record, fields: field });
};

/** Whether `a` is strictly before `b`. */
export const isBefore = (a: Date, b: Date): boolean => a.getTime() < b.getTime();

/** Whether `a` is at or before `b`: a deadline at `now` is over. */
export const isAtOrBefore = (a: Date, b: Date): boolean => a.getTime() <= b.getTime();

/** The order of two instants (for `sort`): negative when `a` is earlier. */
export const compareInstants = (a: Date, b: Date): number => a.getTime() - b.getTime();

/** The earlier of the instants given (the first when they are the same); `undefined`: none was given. */
export const earliestOf = (...instants: readonly (Date | undefined)[]): Date | undefined =>
  instants.reduce<Date | undefined>(
    (first, next) =>
      next === undefined || (first !== undefined && !isBefore(next, first)) ? first : next,
    undefined,
  );

/**
 * A copy of an instant: what a surface that user code sees (an event, a hook's context, a listing)
 * carries, so that a `setTime` there never moves the time a store holds or a compare-and-set reads.
 */
export const copyOf = (at: Date): Date => new Date(at.getTime());

/** `copyOf` of a time that may be absent. */
export const copyOfOptional = (at: Date | undefined): Date | undefined =>
  at === undefined ? undefined : copyOf(at);

/** The one spelling of a time a store keeps as text: what `toISOString()` writes (four-digit year, milliseconds, `Z`). */
const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Whether a text is exactly what `toISOString()` writes for some instant: the only spelling a store's
 * raw column or JSON keeps of a time, so the order of the texts (a column's index, a text sort) is the
 * order of the instants.
 */
export const isCanonicalInstantText = (text: string): boolean => {
  if (!CANONICAL.test(text)) return false;
  const at = new Date(text);
  return !Number.isNaN(at.getTime()) && at.toISOString() === text;
};

/**
 * The instant a stored text names. Only the canonical `toISOString()` text is read; any other
 * spelling (no zone, an offset, no milliseconds, a year past 9999, an unparsable text) is a loud
 * `StoreError.UnreadableRecord`, never an Invalid Date or a time read in the process's zone. `field`
 * names it; the value is never in the error.
 */
export const instantOfText = (text: string, field: string, record = "pause"): Date => {
  if (!isCanonicalInstantText(text))
    throw new StoreError.UnreadableRecord({ record, fields: field });
  return new Date(text);
};

/** `instantOfText` of a text that may be absent. */
export const instantOfOptionalText = (
  text: string | null | undefined,
  field: string,
  record = "pause",
): Date | undefined =>
  text === undefined || text === null ? undefined : instantOfText(text, field, record);

/** Whether a deadline is at or before `now`: over. No deadline is never over. */
export const isDeadlineDue = (expiresAt: Date | undefined, now: Date): boolean =>
  expiresAt !== undefined && isAtOrBefore(expiresAt, now);
