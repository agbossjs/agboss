/**
 * What a listing takes (#1324e): an opaque cursor and a page size. The one shape of paging across
 * `App`, the stores and the transports; the cursor is a value an earlier `Page.nextCursor` gave,
 * never one a caller builds.
 */
export interface PageQuery {
  /** Where to continue: the `nextCursor` of the page before; omitted → the first page. */
  readonly cursor?: string;
  /** The most items one page holds; omitted → the listing's default. */
  readonly limit?: number;
}

/** What a listing gives (#1324e): the items of one page, and the cursor of the page after it. */
export interface Page<TItem> {
  /** The page's items, in the listing's order. */
  readonly items: readonly TItem[];
  /** The cursor of the next page; absent on the last one. */
  readonly nextCursor?: string;
}
