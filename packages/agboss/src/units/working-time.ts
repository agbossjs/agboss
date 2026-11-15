import { isWorkingDuration, type Milliseconds, type WorkingDuration } from "./index.js";

/** A deadline's or a reminder's length: plain wall-clock time, or working time (#944). */
export type TimeSpan = Milliseconds | WorkingDuration;

/** The key `workingHours` keeps its amount under (`units/index.ts`): a symbol shared by every copy. */
const workingDuration = Symbol.for("agboss.units.working-duration");

/** The amount of a plain or a working duration, in milliseconds. */
export const amountOf = (span: TimeSpan): Milliseconds =>
  isWorkingDuration(span) ? (Reflect.get(span, workingDuration) as Milliseconds) : span;

/** Two spans are the same: the same kind and amount (working time is never plain time). */
export const isSameSpan = (left: TimeSpan | undefined, right: TimeSpan | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    isWorkingDuration(left) === isWorkingDuration(right) &&
    amountOf(left) === amountOf(right));

/** A span as a message names it: `3600000` for plain time, `3600000 ms of working time` for working time. */
export const spanText = (span: unknown): string =>
  isWorkingDuration(span) ? `${String(amountOf(span))} ms of working time` : String(span);

/** The longest deadline or reminder, plain or working: 5 years — a larger value is a mistake, and would walk the calendar for ever. */
export const MAX_SPAN_MS = 5 * 366 * 24 * 3_600_000;
