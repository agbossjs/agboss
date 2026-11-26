/**
 * The one reading of a point in time a listing's filter takes (`expiringBefore`, `startedAfter`,
 * `startedBefore`; #1307e): a valid `Date`, or an ISO 8601 text WITH its zone (`Z` or `±hh:mm`).
 * Never the host's guess: `"5"`, `"Nov 26 2026"` and a time without a zone read differently on
 * different pods (or not at all), so they are refused.
 */

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant `value` names; `undefined` when it is neither a valid `Date` nor an ISO 8601 text with a zone. */
export function instantOf(value: unknown): Date | undefined {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" && ISO_WITH_ZONE.test(value)
        ? new Date(value)
        : undefined;
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
}

/** What an issue says of a filter that is no instant. */
export const INSTANT_REASON =
  "a valid Date, or an ISO 8601 text with its zone (2026-11-26T10:00:00Z)";
