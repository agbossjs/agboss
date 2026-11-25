import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { InterruptMode } from "../../app/interrupt-types.js";
import type { SqliteConnection } from "./sqlite-connection.js";
import type { TreeMarks } from "../execution-lease-contract.js";
import { sqliteStatusLog, type NewStatusTransition } from "../../turns/index.js";

/**
 * The stop mark on a SQLite file (#1341b): the columns `stop_requested_at` and `stop_mode` of the
 * tree's row of `execution_leases`, written by the lease store's `requestStop` and read by both
 * fencing stores inside their own `BEGIN IMMEDIATE` transactions (`checkSqliteCancel`). Never
 * cleared; the mode only escalates, `after-step` to `immediate`.
 */

const StopRow = z.object({ stop_mode: z.enum(InterruptMode).nullable() });

/** The mode of the tree's stop mark; `undefined` for a tree never stopped. */
export function stopModeOf(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
): InterruptMode | undefined {
  const row = database
    .prepare("SELECT stop_mode FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?")
    .get(tree.tenantId, tree.rootExecutionId);
  return row === undefined ? undefined : (StopRow.parse(row).stop_mode ?? undefined);
}

/**
 * Marks the tree's stop at `now` (ms) on its lease row, in the caller's transaction: once, escalated
 * from `after-step` to `immediate`, never lowered; a tree with no row gets a seed row (token 0,
 * released, never held). The history row is written only when this call set or escalated the mark.
 */
export function markedStopRequested(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  stop: {
    readonly mode: InterruptMode;
    readonly now: number;
    readonly transition?: NewStatusTransition;
  },
): void {
  const before = stopModeOf(database, tree);
  const isEscalated = before === InterruptMode.AfterStep && stop.mode === InterruptMode.Immediate;
  if (before !== undefined && !isEscalated) return;
  database
    .prepare(
      `INSERT INTO execution_leases (tenant_id, root_execution_id, holder_instance_id, lease_epoch,
         expires_at, released, yielded, stop_requested_at, stop_mode) VALUES (?, ?, '', 0, 0, 1, 0, ?, ?)
       ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
         stop_requested_at = COALESCE(execution_leases.stop_requested_at, excluded.stop_requested_at),
         stop_mode = excluded.stop_mode`,
    )
    .run(tree.tenantId, tree.rootExecutionId, stop.now, stop.mode);
  if (stop.transition !== undefined)
    sqliteStatusLog(database).appended(stop.transition, new Date(stop.now));
}

const MarksRow = z.object({
  is_cancelled: z.number().transform(Boolean),
  stop_mode: z.enum(InterruptMode).nullable(),
});

/** Both marks of the tree\'s lease row in one read: its cancel mark and its stop mark. */
export function marksOf(
  database: DatabaseSync,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
): TreeMarks {
  const row = database
    .prepare(
      `SELECT cancel_requested_at IS NOT NULL AS is_cancelled, stop_mode FROM execution_leases
       WHERE tenant_id = ? AND root_execution_id = ?`,
    )
    .get(tree.tenantId, tree.rootExecutionId);
  if (row === undefined) return { isCancelRequested: false };
  const { is_cancelled: isCancelRequested, stop_mode: mode } = MarksRow.parse(row);
  return { isCancelRequested, ...(mode === null ? {} : { stop: { mode } }) };
}

/**
 * Whether a tree carries a stop or a cancel mark on its lease row of this file (#1341b): read by the
 * SQLite records inside the finish's own `BEGIN IMMEDIATE`, which a mark's own one serializes with.
 */
export const sqliteInterruptedOf =
  (database: DatabaseSync) =>
  (tree: { readonly tenantId: string; readonly rootExecutionId: string }): boolean => {
    const marks = marksOf(database, tree);
    return marks.isCancelRequested || marks.stop !== undefined;
  };

/** `markedStopRequested` in a `BEGIN IMMEDIATE` of its own, like every fenced method, so the mark and its row serialize with them. */
export function stopRequestedOn(
  connection: SqliteConnection,
  tree: { readonly tenantId: string; readonly rootExecutionId: string },
  stop: {
    readonly mode: InterruptMode;
    readonly now: number;
    readonly transition?: NewStatusTransition | undefined;
  },
): void {
  connection.transaction(() => {
    markedStopRequested(connection.database, tree, {
      mode: stop.mode,
      now: stop.now,
      ...(stop.transition ? { transition: stop.transition } : {}),
    });
  });
}
