import type { DatabaseSync } from "node:sqlite";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import type { EffectKey } from "../effect-key.js";
import { cancelTreeOf } from "../issued-keys.js";

/**
 * The cancel mark on a SQLite file (#909): the table `execution_cancel_requests` is created with
 * the leases' (`EXECUTION_LEASES_SCHEMA`), written by the lease store's `requestCancel` and read by
 * both fencing stores inside their own `BEGIN IMMEDIATE` transactions — which an `INSERT OR IGNORE`
 * in a `BEGIN IMMEDIATE` of its own serializes with.
 */

/** Marks the tree's cancel at `now` (ms): once, a repeat changes nothing. */
export function markedCancelRequested(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  now: number,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO execution_cancel_requests (tenant_id, root_execution_id, requested_at) VALUES (?, ?, ?)",
    )
    .run(tree.tenantId, tree.rootExecutionId, now);
}

/**
 * The cancel check of the SQLite stores, inside the caller's transaction: the key's tree has a
 * cancel request and the key is not an undo's → `ExecutionCancelFencedError`, nothing written or
 * sent. After the lease and mark checks and, for an effect, after the key's lookup.
 */
export function checkSqliteCancel(database: DatabaseSync, key: EffectKey): void {
  if (key.isCompensation === true) return;
  const { tenantId, rootExecutionId } = cancelTreeOf(key);
  const found = database
    .prepare(
      "SELECT 1 AS found FROM execution_cancel_requests WHERE tenant_id = ? AND root_execution_id = ?",
    )
    .get(tenantId, rootExecutionId);
  if (found !== undefined) throw ExecutionCancelFencedError.of(key);
}

/** Removes the cancel requests older than `before` (ms): the fencing stores' retention. */
export function prunedCancelRequests(database: DatabaseSync, before: number): void {
  database.prepare("DELETE FROM execution_cancel_requests WHERE requested_at < ?").run(before);
}
