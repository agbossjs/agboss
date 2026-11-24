import type { Page, PageQuery } from "../app/page.js";
import type { Turn } from "../turns/index.js";
import type { ExecutionRecordStatus } from "./execution-record.repository.js";

/** Which records a listing reads: those in `status`, a page of them (`cursor`, `limit`). */
export interface ExecutionRecordStatusQuery extends PageQuery {
  readonly status: ExecutionRecordStatus;
}

/** The default size of a page of `findByStatus`, as recovery reads it. */
const STATUS_PAGE_LIMIT = 100;

/**
 * The page of `query` from a store that reads `limit` records after the id `after` (the cursor is
 * the id of the last record of the page before): one more than the page is read, to know whether
 * another page follows.
 */
export async function statusPageOf(
  query: ExecutionRecordStatusQuery,
  read: (limit: number, after: string | undefined) => Promise<Turn[]>,
): Promise<Page<Turn>> {
  const limit = query.limit ?? STATUS_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("a page's limit is a positive whole number");
  const found = await read(limit + 1, query.cursor);
  const items = found.slice(0, limit);
  const last = items.at(-1);
  return found.length > limit && last !== undefined ? { items, nextCursor: last.id } : { items };
}
