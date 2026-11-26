/**
 * A fact `Date` as an error's message and `details` say it (an error is never the reason to throw):
 * ISO 8601; `fallback` when it is absent; "an invalid time" when it is a `Date` of no instant — the
 * fact is shown, not hidden as an unknown time.
 */
export const timeText = (at: Date | undefined, fallback: string): string =>
  at === undefined ? fallback : Number.isNaN(at.getTime()) ? "an invalid time" : at.toISOString();

/** The ISO 8601 text of a valid `Date`; `undefined` when absent or of no instant (a wire field is left out, never made up). */
export const isoOf = (at: Date | undefined): string | undefined =>
  at === undefined || Number.isNaN(at.getTime()) ? undefined : at.toISOString();
