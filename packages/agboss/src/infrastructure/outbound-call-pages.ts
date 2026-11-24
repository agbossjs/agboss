import type { Page, PageQuery } from "../app/page.js";
import { definedOf } from "./clock.js";
import type { InMemoryDatabase } from "./in-memory-database.js";
import type { OutboundCallRecord } from "./outbound-call-record.js";
import type { OutboundCallStatus } from "./outbound-call.repository.js";

/**
 * A paged listing of a tenant's calls by status (#825): the query, the page, and the keyset helpers
 * the core's stores share — read one row past the page, its last row's place the next cursor.
 */

/**
 * Which calls `findAllByTenantIdAndStatus` reads (#825, #1321b): a tenant's in one status, a page of
 * them — `limit` (a whole number from 1; none → `DEFAULT_OUTBOUND_CALL_PAGE`) and the `cursor` a page
 * before handed out as `nextCursor` (none → from the first).
 */
export interface OutboundCallStatusQuery extends PageQuery {
  readonly tenantId: string;
  readonly status: OutboundCallStatus;
}

/**
 * A page of a tenant's calls as `app.pendingOutboundCallsOf` gives it (#825): the calls, and the
 * cursor of the next page when more may follow. A store's page is `Page<OutboundCallRecord>`.
 */
export interface OutboundCallPage {
  readonly calls: readonly OutboundCallRecord[];
  /** The cursor to pass as `after`; absent → this is the last page. */
  readonly next?: string;
}

/** The size of a page of calls when none is asked (#825). */
export const DEFAULT_OUTBOUND_CALL_PAGE = 100;
/** The largest page of calls a read asks for (#825). */
export const MAX_OUTBOUND_CALL_PAGE = 1000;

/** One row of a page as read: its record and its place in the store's record order. */
export interface PagedCall {
  readonly record: OutboundCallRecord;
  readonly place: number;
}

/**
 * The page of `limit` of `rows`, read one past it in the record order: the first `limit`, and the
 * place of the last as `next` when a row followed it.
 */
export function outboundCallPageOf(
  rows: readonly PagedCall[],
  limit: number,
): Page<OutboundCallRecord> {
  const page = rows.slice(0, limit);
  const items = page.map((row) => row.record);
  if (rows.length <= limit) return { items };
  // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
  const last = definedOf(page.at(-1), "a page with a row past its limit has a last row");
  return { items, nextCursor: String(last.place) };
}

/**
 * `limit`, checked at the store's entry (#825): a whole number from 1 — `0`, a fraction or `NaN` would
 * read as an empty last page, a negative one as no limit at all. A `RangeError` otherwise.
 */
export function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_OUTBOUND_CALL_PAGE;
  if (Number.isSafeInteger(limit) && limit >= 1) return limit;
  throw new RangeError(`a page's limit is a whole number of calls from 1, got ${String(limit)}`);
}

/** The place a cursor of a core store names: a whole number from 1, as it was handed out. */
export function placeOfCursor(cursor: string): number {
  const place = Number(cursor);
  if (/^[1-9][0-9]*$/u.test(cursor) && Number.isSafeInteger(place)) return place;
  throw new RangeError("the cursor is not one this store gave: pass the next of one of its pages");
}

/** The next place in a database's record order (#825): one past the highest given, never given again. */
export function nextPlaceIn(database: Pick<InMemoryDatabase, "outboundCallPlaces">): number {
  database.outboundCallPlaces.highest += 1;
  return database.outboundCallPlaces.highest;
}

/** A row's place in an in-memory record order (#825): every intent recorded has one. */
export function placeIn(order: ReadonlyMap<string, number>, row: string): number {
  const place = order.get(row);
  if (place !== undefined) return place;
  throw new Error(
    "an in-memory outbound call without its place in the record order: written past saveIfAbsent",
  );
}

/**
 * A page of a tenant's calls in `status` in an in-memory database (#825): keyset on each intent's
 * place in the record order — given once, never reused, kept by a move. A refused limit or cursor
 * rejects the call.
 */
export function inMemoryPageOf(
  database: InMemoryDatabase,
  query: OutboundCallStatusQuery,
): Promise<Page<OutboundCallRecord>> {
  return new Promise((resolve) => {
    const { tenantId, status, cursor } = query;
    const limit = pageLimitOf(query.limit);
    const from = cursor === undefined ? 0 : placeOfCursor(cursor);
    const { outboundCalls, outboundCallOrder } = database;
    // a row is inserted when its place is given and keeps its position while it lives: the map's
    // order is the record order, so the rows come in it as they are
    const rows = [...outboundCalls]
      .map(([row, record]) => ({ place: placeIn(outboundCallOrder, row), record }))
      .filter(({ place, record }) => place > from && record.tenantId === tenantId)
      .filter(({ record }) => record.status === status)
      .map(({ place, record }) => ({ place, record: structuredClone(record) }));
    resolve(outboundCallPageOf(rows, limit));
  });
}
