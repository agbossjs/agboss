import type { DatabaseSync } from "node:sqlite";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import { sqliteStatusLog, type NewStatusTransition } from "../../turns/index.js";
import type { EffectKey } from "../effect-key.js";
import { cancelTreeOf } from "../issued-keys.js";

/**
 * The cancel mark on a SQLite file (#909, #1117): the column `cancel_requested_at` of the tree's
 * row of `execution_leases` (`sqlite-lease-schema.ts`), written by the lease store's
 * `requestCancel` and read by both fencing stores inside their own `BEGIN IMMEDIATE` transactions —
 * which the mark's write in a `BEGIN IMMEDIATE` of its own serializes with. Never cleared: no
 * retention, release, retire or take of the lease lifts it.
 */

/**
 * Marks the tree's cancel at `now` (ms) on its lease row: once, a repeat changes nothing. A tree
 * with no row yet (a cancel before its first acquire) gets a seed row — token 0, released, never
 * held — so that acquire is token 1 and no takeover.
 */
export function markedCancelRequested(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  now: number,
  transition?: NewStatusTransition,
): void {
  const wasMarked =
    database
      .prepare(
        `SELECT 1 AS found FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?
         AND cancel_requested_at IS NOT NULL`,
      )
      .get(tree.tenantId, tree.rootExecutionId) !== undefined;
  database
    .prepare(
      `INSERT INTO execution_leases (tenant_id, root_execution_id, holder_instance_id, lease_epoch,
         expires_at, released, yielded, cancel_requested_at) VALUES (?, ?, '', 0, 0, 1, 0, ?)
       ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
         cancel_requested_at = COALESCE(execution_leases.cancel_requested_at, excluded.cancel_requested_at)`,
    )
    .run(tree.tenantId, tree.rootExecutionId, now);
  // the mark and its history row are one transaction: the caller's `BEGIN IMMEDIATE` (#1341d)
  if (transition !== undefined && !wasMarked)
    sqliteStatusLog(database).appended(transition, new Date(now));
}

/**
 * The cancel check of the SQLite stores, inside the caller's transaction: the key's tree — its
 * root's lease row — carries the mark and the key is not an undo's → `ExecutionCancelFencedError`,
 * nothing written or sent. After the lease and mark checks and, for an effect, after the key's
 * lookup.
 */
export function checkSqliteCancel(database: DatabaseSync, key: EffectKey): void {
  if (key.isCompensation === true) return;
  const { tenantId, rootExecutionId } = cancelTreeOf(key);
  const found = database
    .prepare(
      `SELECT 1 AS found FROM execution_leases
       WHERE tenant_id = ? AND root_execution_id = ? AND cancel_requested_at IS NOT NULL`,
    )
    .get(tenantId, rootExecutionId);
  if (found !== undefined) throw ExecutionCancelFencedError.of(key);
}
