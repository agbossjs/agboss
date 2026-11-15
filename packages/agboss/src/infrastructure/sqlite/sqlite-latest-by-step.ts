import { z } from "zod";
import {
  HAS_UNREADABLE_STEP_SQL,
  LATEST_BY_STEP_SQL,
  NEWEST_READABLE_STEP_SQL,
  UNREADABLE_STEP_ROWS_SQL,
  CHECKPOINT_ROW_SQL,
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

/** A candidate for the newest of a namespace: its id and step, no blob. */
export interface StepCandidate {
  readonly id: string;
  readonly step: number;
}

const ReadableRow = z.object({ checkpoint_id: z.string(), step: z.number() });
const UnreadableRow = z.object({
  checkpoint_id: z.string(),
  metadata_type: z.string(),
  metadata: z.instanceof(Uint8Array),
});

/** The unreadable rows' ids with their metadata, and the index's newest readable row, of one namespace. */
export interface StepsToRank {
  /** The newest of the rows whose `step` SQL reads: one walk of the index; `undefined` when none. */
  readonly readable: StepCandidate | undefined;
  /** The rows at -2, each to be read by the serde (#1101, #1114). */
  readonly unreadable: readonly z.infer<typeof UnreadableRow>[];
}

/**
 * What to rank when a namespace has a row whose `step` the generated column cannot vouch for (#1101, #1114),
 * else `undefined` (the caller then answers by the index alone). One probe of a partial index; then the
 * index's newest row among the readable ones, and the rows at -2 with their metadata only: O(rows at -2),
 * never the namespace's checkpoint blobs (#1144).
 */
export function stepsToRank(
  connection: SqliteConnection,
  { threadId, namespace }: { readonly threadId: string; readonly namespace: string },
): StepsToRank | undefined {
  const { database } = connection;
  if (database.prepare(HAS_UNREADABLE_STEP_SQL).get(threadId, namespace) === undefined)
    return undefined;
  const newest = database.prepare(NEWEST_READABLE_STEP_SQL).get(threadId, namespace);
  return {
    readable:
      newest === undefined
        ? undefined
        : (({ checkpoint_id: id, step }) => ({ id, step }))(ReadableRow.parse(newest)),
    unreadable: database
      .prepare(UNREADABLE_STEP_ROWS_SQL)
      .all(threadId, namespace)
      .map((row) => UnreadableRow.parse(row)),
  };
}

/** The whole row of one checkpoint of the namespace, the winner's. */
export function rowOf(
  connection: SqliteConnection,
  { threadId, namespace }: { readonly threadId: string; readonly namespace: string },
  checkpointId: string,
): Record<string, unknown> | undefined {
  return connection.database.prepare(CHECKPOINT_ROW_SQL).get(threadId, namespace, checkpointId);
}
