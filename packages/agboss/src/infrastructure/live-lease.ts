import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";
import { OutboundCallLeaseState } from "./execution-lease-event.repository.js";
import type { OutboundCallLease } from "./outbound-call-record.js";

/**
 * The state of a lease that wrote a pending outbound call (#508), loaded on the first check — in
 * memory and on SQLite. An expired one is closed by the check itself, in the same atomic step:
 * released at its token — marked superseded (in memory `isSuperseded`, on SQLite `released = 2`), so
 * the next take still names its holder and token (`takenOverFrom`) — and its holder can neither
 * renew it nor write under it again.
 */

/** A lease row as read here. */
const LeaseRow = z.object({ lease_epoch: z.number(), released: z.number() });

/** The in-memory store's `leaseStateOf`: one synchronous step on the shared database. */
export function inMemoryLeaseStateOf(
  database: InMemoryDatabase,
  lease: OutboundCallLease,
  now: Date,
): OutboundCallLeaseState {
  const key = treeKeyOf(lease.tenantId, lease.leaseExecutionId);
  const row = database.executionLeases.get(key);
  if (row === undefined || row.released || row.lease.leaseEpoch !== lease.token)
    return OutboundCallLeaseState.Ended;
  if (row.lease.expiresAt > now) return OutboundCallLeaseState.Live;
  database.executionLeases.set(key, { ...row, released: true, isSuperseded: true });
  return OutboundCallLeaseState.Superseded;
}

/**
 * The SQLite store's `leaseStateOf`: the close is one conditional `UPDATE` (still at `token`, not
 * released, expired) — one row changed is `Superseded`; else the row read after it says `Live` (a
 * renewal landed first) or `Ended`.
 */
export function sqliteLeaseStateOf(
  database: DatabaseSync,
  lease: OutboundCallLease,
  now: Date,
): OutboundCallLeaseState {
  const { tenantId, leaseExecutionId, token } = lease;
  const closed = database
    .prepare(
      "UPDATE execution_leases SET released = 2 WHERE tenant_id = ? AND root_execution_id = ? AND lease_epoch = ? AND released = 0 AND expires_at <= ?",
    )
    .run(tenantId, leaseExecutionId, token, now.getTime());
  if (closed.changes === 1) return OutboundCallLeaseState.Superseded;
  const row = database
    .prepare(
      "SELECT lease_epoch, released FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(tenantId, leaseExecutionId);
  const found = row === undefined ? undefined : LeaseRow.parse(row);
  return found?.released === 0 && found.lease_epoch === token
    ? OutboundCallLeaseState.Live
    : OutboundCallLeaseState.Ended;
}
