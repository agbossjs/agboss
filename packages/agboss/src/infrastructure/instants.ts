/**
 * Comparing moments (G3, #1307): a pause's times are `Date`s in memory, and `===`, `!==` and `<` on
 * two `Date`s compare references, never instants — a compare-and-set written that way loses every time
 * (`UpdateContended` for good) or, worse, wins when it must not. Every comparison of a pause's times
 * goes through here: two `Date`s are the same instant when their milliseconds are.
 */

/** Whether both name the same instant; two absent times (`undefined`) are the same. */
export const sameInstant = (a: Date | undefined, b: Date | undefined): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Whether `a` is strictly before `b`. */
export const isBefore = (a: Date, b: Date): boolean => a.getTime() < b.getTime();
