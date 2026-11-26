/** A fact `Date` as an error's message and `details` say it: ISO 8601, or `fallback` when absent or no valid date (an error is never the reason to throw). */
export const timeText = (at: Date | undefined, fallback: string): string =>
  at === undefined || Number.isNaN(at.getTime()) ? fallback : at.toISOString();
