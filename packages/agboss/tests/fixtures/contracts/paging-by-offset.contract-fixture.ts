// #825 acceptance: the paged listing's cases against stores that page the naive ways — by an offset
// into the matching rows, and by the identity of the last row (gone once the row is removed).
import {
  InMemoryOutboundCallRepository,
  type OutboundCallRecord,
  type Page,
} from "../../../src/index.js";
import { type OutboundCallStatusQuery } from "../../../src/stores/index.js";
import { outboundCallContract } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

/** Every matching row, as the core's in-memory store lists it in one page. */
async function allOf(
  store: InMemoryOutboundCallRepository,
  query: OutboundCallStatusQuery,
): Promise<readonly OutboundCallRecord[]> {
  const page = await InMemoryOutboundCallRepository.prototype.findAllByTenantIdAndStatus.call(
    store,
    { ...query, limit: 1_000_000 },
  );
  return page.items;
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
