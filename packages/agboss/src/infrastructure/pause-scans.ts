import { definedOf } from "./clock.js";
import { compareInstants, isBefore } from "./instants.js";
import type { PauseFilter, PausePage } from "./pause-notices.js";
import type { PauseRecord } from "./pause-record.js";

/**
 * What the pause scans share across the core's stores (#935, #910 rules 9, 14): the page size
 * every scan takes, the filter of a tenant's page, and the cursor — an opaque text over the store's
 * monotonic insertion sequence, never a position in a list, so a removal between two pages skips
 * nothing (V10.2).
 */

/** The largest page a scan returns. */
export const MAX_SCAN_LIMIT = 1000;

/** Throws unless `limit` is a whole number from 1 to 1000. */
export function assertScanLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT)
    throw new RangeError(
      `a pause scan's limit is a whole number from 1 to ${String(MAX_SCAN_LIMIT)}, not ${String(limit)}`,
    );
}

/** Throws unless the filter names at least one status. */
export function assertPauseFilter(filter: PauseFilter): void {
  if (filter.statuses.length === 0) throw new TypeError("a pause filter names at least one status");
}

/** Throws unless a listing's `limit` and `filter` are well formed. */
export function assertListing(filter: PauseFilter, limit: number): void {
  assertScanLimit(limit);
  assertPauseFilter(filter);
}

/** Whether `pause` is what `filter` selects. */
export const matchesFilter = (pause: PauseRecord, filter: PauseFilter): boolean =>
  filter.statuses.includes(pause.status) &&
  (filter.target === undefined || pause.target === filter.target) &&
  (filter.channel === undefined || pause.channel === filter.channel) &&
  (filter.expiresBefore === undefined ||
    (pause.expiresAt !== undefined && isBefore(pause.expiresAt, filter.expiresBefore))) &&
  heldAs(pause, filter);

/** Whether `pause` is the one `filter`'s assignee and external reference name (those it names). */
const heldAs = (pause: PauseRecord, { assignee, externalRef }: PauseFilter): boolean =>
  (assignee === undefined || (pause.assignees?.includes(assignee) ?? false)) &&
  (externalRef === undefined || pause.externalRef === externalRef);

/** What a page selects: the pauses `filter` selects, of `tenantId` or (none given) of every tenant. */
export const inScope =
  (filter: PauseFilter, tenantId?: string) =>
  ({ pause }: { readonly pause: PauseRecord }): boolean =>
    (tenantId === undefined || pause.tenantId === tenantId) && matchesFilter(pause, filter);

/** Text order by code unit — SQLite's binary collation — never the locale's. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The cursor that continues after the record of insertion sequence `seq`. */
export const cursorOfSeq = (seq: number): string => String(seq);

/** The insertion sequence a cursor continues after; no cursor: from the start. */
export function seqOfCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const seq = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(seq))
    throw new TypeError(`${JSON.stringify(cursor)} is not a pause page cursor`);
  return seq;
}

/** A pause of a store with its place in the store's insertion order. */
export interface SequencedPause {
  readonly pause: PauseRecord;
  readonly seq: number;
}

/** The cursor that continues after the last of a page that more follow. */
const cursorAfter = (page: readonly SequencedPause[]): string =>
  // Stryker disable next-line StringLiteral: a page that more follow is not empty (its limit is from 1), so the text is never thrown
  cursorOfSeq(definedOf(page.at(-1), "a page that more follow is not empty").seq);

/** The page of the first `limit` of `ordered`; `next` only when more follow. */
export function pageOf(ordered: readonly SequencedPause[], limit: number): PausePage {
  const page = ordered.slice(0, limit);
  return {
    pauses: page.map((one) => one.pause),
    ...(ordered.length > limit ? { next: cursorAfter(page) } : {}),
  };
}

/** A pause with the time a scan reads on it. */
export interface Timed {
  readonly time: Date;
  readonly pause: PauseRecord;
}

/** The first `limit` pauses by their time, then tenant and id: the deadline scans' order. */
export const firstByTime = (timed: readonly Timed[], limit: number): PauseRecord[] =>
  [...timed]
    .sort(
      (a, b) =>
        compareInstants(a.time, b.time) ||
        compareText(a.pause.tenantId, b.pause.tenantId) ||
        compareText(a.pause.pauseId, b.pause.pauseId),
    )
    .slice(0, limit)
    .map(({ pause }) => pause);
