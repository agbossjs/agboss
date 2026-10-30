import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FencedEffectKey } from "./fenced-effect.repository.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

/**
 * Whether a lease that wrote a pending outbound call is live (#508), loaded on the first check — in
 * memory and on SQLite: an expired one is superseded by the check itself.
 */

/** A lease row as read here. */
const LeaseRow = z.object({ lease_epoch: z.number(), released: z.number() });

/**
 * Whether the lease of `(tenantId, leaseExecutionId)` is live at `token` (#508): neither released,
 * superseded by a later token, nor expired. One expired at `token` is superseded here, at once — its
 * epoch moved past `token`, the row kept unreleased — so its holder can neither renew it nor write
 * under it again, and its tree is taken over as after any expiry.
 */
export function isInMemoryLeaseLive(
  database: InMemoryDatabase,
  lease: Pick<FencedEffectKey, "tenantId" | "leaseExecutionId" | "token">,
  now: Date,
): boolean {
  const key = treeKeyOf(lease.tenantId, lease.leaseExecutionId);
  const row = database.executionLeases.get(key);
  if (row === undefined || row.released || row.lease.leaseEpoch !== lease.token) return false;
  if (row.lease.expiresAt > now) return true;
  const superseded = { ...row.lease, leaseEpoch: row.lease.leaseEpoch + 1 };
  database.executionLeases.set(key, { ...row, lease: superseded });
  return false;
}

/**
 * Whether the lease of `(tenantId, leaseExecutionId)` is live at `token` (#508): neither released,
 * superseded by a later token, nor expired. One expired at `token` is superseded here, in one
 * statement — its epoch moved past `token`, the row kept unreleased — so its holder can neither
 * renew it nor write under it again, and its tree is taken over as after any expiry.
 */
export function isSqliteLeaseLive(
  database: DatabaseSync,
  lease: Pick<FencedEffectKey, "tenantId" | "leaseExecutionId" | "token">,
  now: Date,
): boolean {
  const { tenantId, leaseExecutionId, token } = lease;
  database
    .prepare(
      "UPDATE execution_leases SET lease_epoch = lease_epoch + 1 WHERE tenant_id = ? AND root_execution_id = ? AND lease_epoch = ? AND released = 0 AND expires_at <= ?",
    )
    .run(tenantId, leaseExecutionId, token, now.getTime());
  const row = database
    .prepare(
      "SELECT lease_epoch, released FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(tenantId, leaseExecutionId);
  const found = row === undefined ? undefined : LeaseRow.parse(row);
  return found?.released === 0 && found.lease_epoch === token;
}
