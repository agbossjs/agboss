import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  outboundCallPageOf,
  pageLimitOf,
  placeOfCursor,
  type OutboundCallPage,
  type OutboundCallStatusQuery,
} from "../outbound-call-pages.js";
import type { OutboundCallRecord } from "../outbound-call-record.js";

const PagedRow = z.object({ seq: z.number().int(), record: z.string() });

const PAGE =
  "SELECT seq, record FROM outbound_calls WHERE tenant_id = ? AND status = ? AND seq > ? ORDER BY seq LIMIT ?";

/**
 * A page of a tenant's calls in `status` on the SQLite file (#825): keyset on `seq` — the row's
 * declared rowid, kept while it lives (a `VACUUM` or a restore keeps it too) and never given again
 * (`AUTOINCREMENT`), so no page repeats or skips one. The cursor is the page's last `seq`, as text; a
 * refused limit or cursor rejects the call.
 */
export function sqlitePageOf(
  database: DatabaseSync,
  query: OutboundCallStatusQuery,
  recordOf: (row: unknown) => OutboundCallRecord,
): Promise<OutboundCallPage> {
  return new Promise((resolve) => {
    const { tenantId, status, after } = query;
    const limit = pageLimitOf(query.limit);
    const from = after === undefined ? 0 : placeOfCursor(after);
    const rows = database
      .prepare(PAGE)
      .all(tenantId, status, from, limit + 1)
      .map((row) => ({ place: PagedRow.parse(row).seq, record: recordOf(row) }));
    resolve(outboundCallPageOf(rows, limit));
  });
}
