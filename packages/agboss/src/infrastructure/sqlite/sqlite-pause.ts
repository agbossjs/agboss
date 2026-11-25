import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { InterruptMode } from "../../app/interrupt-types.js";
import { sqliteStatusLog, type NewStatusTransition } from "../../turns/index.js";
import type { SqliteConnection } from "./sqlite-connection.js";
import type { PauseMarks, PauseRequest } from "../execution-lease-contract.js";

/**
 * The external pause on a SQLite file (#1341c): the columns `is_externally_paused`,
 * `external_pause_reason` and `fenced_through_token` of the tree's row of `execution_leases`, written
 * by the lease store's `requestPause` / `unpause` inside its `BEGIN IMMEDIATE` transaction, with the
 * thread's history row. `fenced_through_token` only ever rises (`MAX`) and `unpause` never lowers it.
 */

interface Tree {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}

const PauseRow = z.object({
  is_externally_paused: z.number(),
  external_pause_reason: z.string().nullable(),
  external_pause_mode: z.string().nullable(),
  fenced_through_token: z.number().nullable(),
  lease_epoch: z.number(),
});

const rowOf = (database: DatabaseSync, tree: Tree) => {
  const row = database
    .prepare(
      `SELECT is_externally_paused, external_pause_reason, external_pause_mode, fenced_through_token,
         lease_epoch
       FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?`,
    )
    .get(tree.tenantId, tree.rootExecutionId);
  return row === undefined ? undefined : PauseRow.parse(row);
};

/** The tree's external pause and its fence. */
export function pauseMarksOf(database: DatabaseSync, tree: Tree): PauseMarks {
  const row = rowOf(database, tree);
  if (row === undefined) return {};
  const reason =
    row.external_pause_reason === null
      ? undefined
      : z.string().parse(JSON.parse(row.external_pause_reason));
  return {
    ...(row.is_externally_paused === 0
      ? {}
      : {
          pause: {
            ...(reason === undefined ? {} : { reason }),
            mode:
              row.external_pause_mode === InterruptMode.Immediate
                ? InterruptMode.Immediate
                : InterruptMode.AfterStep,
          },
        }),
    ...(row.fenced_through_token === null ? {} : { fencedThroughToken: row.fenced_through_token }),
  };
}

/**
 * The `SET` term of a reclaim at the token `next` (an SQL expression over the row; #1341c): while an
 * `Immediate` pause is set, `fenced_through_token` rises to the reclaimed token in the reclaim's own
 * statement — a holder that yielded under the pause gets no token above the fence. `row` names the
 * table the stored columns are read from (an upsert's `execution_leases`, a plain `UPDATE`'s none).
 */
export const reclaimedFenceSql = (next: string, row = ""): string =>
  `fenced_through_token = CASE WHEN ${row}is_externally_paused = 1
     AND ${row}external_pause_mode = '${InterruptMode.Immediate}'
     THEN MAX(COALESCE(${row}fenced_through_token, 0), ${next})
     ELSE ${row}fenced_through_token END`;

/** Marks the tree paused from outside, in the caller's transaction (see `ExecutionLeaseRepository.requestPause`). */
export function markedPaused(
  database: DatabaseSync,
  tree: Tree,
  pause: {
    readonly request: PauseRequest;
    readonly now: number;
    readonly transition?: NewStatusTransition;
  },
): void {
  const wasPaused = rowOf(database, tree)?.is_externally_paused === 1;
  const reason = pause.request.reason === undefined ? null : JSON.stringify(pause.request.reason);
  const isImmediate = pause.request.mode === InterruptMode.Immediate;
  database
    .prepare(
      `INSERT INTO execution_leases (tenant_id, root_execution_id, holder_instance_id, lease_epoch,
         expires_at, released, yielded, is_externally_paused, external_pause_reason, fenced_through_token,
         external_pause_mode)
       VALUES (?, ?, '', 0, 0, 1, 0, 1, ?, ?, ?)
       ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
         is_externally_paused = 1, external_pause_reason = excluded.external_pause_reason,
         external_pause_mode = CASE WHEN execution_leases.is_externally_paused = 1
           AND execution_leases.external_pause_mode = 'immediate' THEN 'immediate'
           ELSE excluded.external_pause_mode END,
         fenced_through_token = CASE WHEN ? THEN MAX(COALESCE(execution_leases.fenced_through_token, 0),
           execution_leases.lease_epoch) ELSE execution_leases.fenced_through_token END`,
    )
    .run(
      ...[tree.tenantId, tree.rootExecutionId, reason, isImmediate ? 0 : null],
      ...[pause.request.mode, isImmediate ? 1 : 0],
    );
  if (!wasPaused && pause.transition !== undefined)
    sqliteStatusLog(database).appended(pause.transition, new Date(pause.now));
}

/** Lifts the pause in the caller's transaction; the fence stays. */
export function liftedPause(
  database: DatabaseSync,
  tree: Tree,
  lift: { readonly now: number; readonly transition?: NewStatusTransition },
): void {
  if (rowOf(database, tree)?.is_externally_paused !== 1) return;
  database
    .prepare(
      `UPDATE execution_leases SET is_externally_paused = 0, external_pause_reason = NULL,
         external_pause_mode = NULL
       WHERE tenant_id = ? AND root_execution_id = ?`,
    )
    .run(tree.tenantId, tree.rootExecutionId);
  if (lift.transition !== undefined)
    sqliteStatusLog(database).appended(lift.transition, new Date(lift.now));
}

/** `markedPaused` in a `BEGIN IMMEDIATE` of its own (see `stopRequestedOn`). */
export function pausedOn(
  connection: SqliteConnection,
  tree: Tree,
  pause: {
    readonly request: PauseRequest;
    readonly now: number;
    readonly transition?: NewStatusTransition | undefined;
  },
): void {
  connection.transaction(() => {
    markedPaused(connection.database, tree, {
      request: pause.request,
      now: pause.now,
      ...(pause.transition ? { transition: pause.transition } : {}),
    });
  });
}

/** `liftedPause` in a `BEGIN IMMEDIATE` of its own. */
export function unpausedOn(
  connection: SqliteConnection,
  tree: Tree,
  lift: { readonly now: number; readonly transition?: NewStatusTransition | undefined },
): void {
  connection.transaction(() => {
    liftedPause(connection.database, tree, {
      now: lift.now,
      ...(lift.transition ? { transition: lift.transition } : {}),
    });
  });
}
