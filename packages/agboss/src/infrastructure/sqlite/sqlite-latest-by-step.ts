import { z } from "zod";
import {
  HAS_UNREADABLE_STEP_SQL,
  LATEST_BY_STEP_SQL,
  NAMESPACE_ROWS_SQL,
  STEP_COLUMN,
  STEP_INDEX,
  UNREADABLE_STEP_INDEX,
} from "./sqlite-checkpoint-rows.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/** `checkpoints.step`, the generated column the newest-by-step index is on (#962, #1035). */

const ColumnInfo = z.object({ name: z.string(), hidden: z.number() });

/** `PRAGMA table_xinfo` `hidden`: 0 an ordinary column, 2 a VIRTUAL generated one, 3 a STORED one. */
const ORDINARY = 0;

/**
 * Gives the file its generated `step` column and the index on it; nothing is written to any row.
 * A file a build before this one converted (a stored `step` column, and an index of rows without
 * one) loses them first.
 */
export function migrateSteps(connection: SqliteConnection): void {
  const { database } = connection;
  connection.transaction(() => {
    const step = database
      .prepare("PRAGMA table_xinfo(checkpoints)")
      .all()
      .map((row) => ColumnInfo.parse(row))
      .find((column) => column.name === "step");
    if (step?.hidden === ORDINARY) {
      database.exec("DROP INDEX IF EXISTS checkpoints_latest_by_step");
      database.exec("DROP INDEX IF EXISTS checkpoints_without_step");
      database.exec("ALTER TABLE checkpoints DROP COLUMN step");
    }
    if (step === undefined || step.hidden === ORDINARY)
      database.exec(`ALTER TABLE checkpoints ADD COLUMN step ${STEP_COLUMN}`);
    database.exec(STEP_INDEX);
    database.exec("DROP INDEX IF EXISTS checkpoints_foreign_metadata");
    database.exec(UNREADABLE_STEP_INDEX);
  });
}

/** The newest row of the thread and namespace by `(step, id)`: one walk of the index. */
export function latestRowOf(
  connection: SqliteConnection,
  { threadId, namespace }: { readonly threadId: string; readonly namespace: string },
): Record<string, unknown> | undefined {
  return connection.database.prepare(LATEST_BY_STEP_SQL).get(threadId, namespace);
}

/**
 * The rows of the namespace when one of them has a `step` the generated column cannot vouch for (#1101, #1114),
 * else `undefined`: the caller then orders them by the serde's own reading, never by a `step` of -2
 * that is a guess. One probe of a partial index.
 */
export function rowsToReadBySerde(
  connection: SqliteConnection,
  { threadId, namespace }: { readonly threadId: string; readonly namespace: string },
): Record<string, unknown>[] | undefined {
  const { database } = connection;
  if (database.prepare(HAS_UNREADABLE_STEP_SQL).get(threadId, namespace) === undefined)
    return undefined;
  return database.prepare(NAMESPACE_ROWS_SQL).all(threadId, namespace);
}
