// #825 acceptance: the paged listing's cases against stores that page the naive ways — by an offset
// into the matching rows, and by the identity of the last row (gone once the row is removed).
import {
  InMemoryOutboundCallRepository,
  type OutboundCallRecord,
  type Page,
} from "../../../src/index.js";
import { type OutboundCallStatusQuery } from "../../../src/stores/index.js";
import { MAX_OUTBOUND_CALL_PAGE } from "../../../src/infrastructure/outbound-call-pages.js";
import { outboundCallContract } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

/** Every matching row, as the core's in-memory store lists it: its own pages (none is larger than the store allows), joined. */
async function allOf(
  store: InMemoryOutboundCallRepository,
  query: OutboundCallStatusQuery,
): Promise<readonly OutboundCallRecord[]> {
  const rows: OutboundCallRecord[] = [];
  const { tenantId, status } = query;
  for (let cursor: string | undefined; ;) {
    const page = await InMemoryOutboundCallRepository.prototype.findAllByTenantIdAndStatus.call(
      store,
      {
        tenantId,
        status,
        limit: MAX_OUTBOUND_CALL_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    rows.push(...page.items);
    if (page.nextCursor === undefined) return rows;
    cursor = page.nextCursor;
  }
}

/** Pages by an offset into what matches now: a row that leaves the status shifts the next page. */
class OffsetPagedCalls extends InMemoryOutboundCallRepository {
  override async findAllByTenantIdAndStatus(
    query: OutboundCallStatusQuery,
  ): Promise<Page<OutboundCallRecord>> {
    const all = await allOf(this, query);
    const limit = query.limit ?? 100;
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const items = all.slice(from, from + limit);
    const next = from + limit;
    return next < all.length ? { items, nextCursor: String(next) } : { items };
  }
}

/** Pages after the row of the cursor's name: none once that row is gone — starts over. */
class NamedCursorCalls extends InMemoryOutboundCallRepository {
  override async findAllByTenantIdAndStatus(
    query: OutboundCallStatusQuery,
  ): Promise<Page<OutboundCallRecord>> {
    const all = await allOf(this, query);
    const limit = query.limit ?? 100;
    const at =
      query.cursor === undefined ? -1 : all.findIndex((call) => call.name === query.cursor);
    const items = all.slice(at + 1, at + 1 + limit);
    const last = items.at(-1);
    return last === undefined || at + 1 + limit >= all.length
      ? { items }
      : { items, nextCursor: last.name };
  }
}

for (const [name, Store] of [
  ["calls paged by an offset", OffsetPagedCalls],
  ["calls paged after the last row's name", NamedCursorCalls],
] as const) {
  outboundCallContract({
    ...inMemoryTarget((seam) => {
      const stores = inMemoryOutboundCalls(seam);
      return { ...stores, calls: new Store(seam.storeClock, seam.database, stores.leases) };
    }),
    name,
  });
}
