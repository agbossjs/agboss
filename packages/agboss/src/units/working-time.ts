import { isWorkingDuration, type Milliseconds, type WorkingDuration } from "./index.js";

/** A deadline's or a reminder's length: plain wall-clock time, or working time (#944). */
export type TimeSpan = Milliseconds | WorkingDuration;

/**
 * The amount of a plain or a working duration, in its own unit: milliseconds for a plain duration
 * and for `workMin` / `workHours`, working days for `workDays` (see `unitOf`).
 */
export const amountOf = (span: TimeSpan): number => (isWorkingDuration(span) ? span.amount : span);

/** What `amountOf` counts: working days for `workDays`, milliseconds for everything else. */
export const unitOf = (span: TimeSpan): "ms" | "days" =>
  isWorkingDuration(span) ? span.unit : "ms";

/** Two spans are the same: the same kind, unit and amount (working time is never plain time). */
export const isSameSpan = (left: TimeSpan | undefined, right: TimeSpan | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    isWorkingDuration(left) === isWorkingDuration(right) &&
    unitOf(left) === unitOf(right) &&
    amountOf(left) === amountOf(right));

/**
 * A span as a message names it: `3600000` for plain time, `3600000 ms of working time` for working
 * time, `2 working days` for `workDays(2)`.
 */
export const spanText = (span: unknown): string => {
  if (!isWorkingDuration(span)) return String(span);
  return span.unit === "days"
    ? `${String(span.amount)} working days`
    : `${String(span.amount)} ms of working time`;
};

/** The longest deadline or reminder, plain or working: 5 years — a larger value is a mistake, and would walk the calendar for ever. */
export const MAX_SPAN_MS = 5 * 366 * 24 * 3_600_000;

/** The most working days a deadline or a reminder counts: 5 years of 366 days. */
export const MAX_SPAN_DAYS = 5 * 366;
