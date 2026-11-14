import { backfillStepsSql, LATEST_BY_STEP_SQL, STEP_INDEXES } from "./sqlite-checkpoint-rows.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/** `checkpoints.step`, its indexes, and the backfill of the rows a file written before has (#962). */

/** Adds the column and the indexes, and gives every old row the step its metadata names. */
export function migrateSteps(connection: SqliteConnection): void {
  connection.addColumn("checkpoints", "step", "INTEGER");
  connection.transaction(() => {
    for (const index of STEP_INDEXES) connection.database.exec(index);
    connection.database.exec(backfillStepsSql(""));
  });
}

/**
 * The newest row of the thread and namespace by `(step, id)`: one walk of the index. Rows written
 * without a step (by an older version still on the file) are given one first, so none is passed over.
 */
export function latestRowOf(
  connection: SqliteConnection,
  { threadId, namespace }: { readonly threadId: string; readonly namespace: string },
): Record<string, unknown> | undefined {
  const { database } = connection;
  const unstepped = database
    .prepare(
      "SELECT 1 FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND step IS NULL LIMIT 1",
    )
    .get(threadId, namespace);
  if (unstepped !== undefined)
    connection.transaction(() => {
      database
        .prepare(backfillStepsSql("AND thread_id = ? AND checkpoint_ns = ?"))
        .run(threadId, namespace);
    });
  return database.prepare(LATEST_BY_STEP_SQL).get(threadId, namespace);
}
