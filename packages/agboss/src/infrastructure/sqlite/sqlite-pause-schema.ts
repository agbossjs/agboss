import { z } from "zod";
import type { SqliteConnection } from "./sqlite-connection.js";

/**
 * The `pauses` table of `SqlitePausedExecutionRepository` (#267 S35): its schema, and the
 * migrations of a file an older version wrote, run in the repository's first transaction.
 */

/** #663: unique per step key of a tree — a step key names no tree, so another tree's never matches. */
const PAUSES_TABLE = `CREATE TABLE IF NOT EXISTS pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`;

const PAUSES_INDEXES = `CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

export const PAUSES_SCHEMA = `${PAUSES_TABLE}\n${PAUSES_INDEXES}`;

/**
 * #663: a file whose pauses were unique per step key of a tenant — the table rebuilt unique per
 * step key of a tree, its rows in their order (`findAllByRoot` reads by `rowid`). Its indexes
 * follow the renamed table and go with it; they are made again on the new one.
 */
const PAUSES_TREE_MIGRATION = `ALTER TABLE pauses RENAME TO pauses_before_trees;
${PAUSES_TABLE}
INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause,
  answer, resolution, resolved_at)
  SELECT tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer,
    resolution, resolved_at FROM pauses_before_trees ORDER BY rowid;
DROP TABLE pauses_before_trees;
${PAUSES_INDEXES}`;

/**
 * The migration of a file written before the pause answer records (#267 S107): the answer column
 * was named `resolution`; how and when a pause was resolved get columns of their own.
 */
const PAUSE_ANSWERS_MIGRATION = `ALTER TABLE pauses RENAME COLUMN resolution TO answer;
ALTER TABLE pauses ADD COLUMN resolution TEXT;
ALTER TABLE pauses ADD COLUMN resolved_at TEXT;
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);`;

const IndexRow = z.object({ name: z.string(), unique: z.number() });
const IndexColumn = z.object({ name: z.string().nullable() });

/**
 * Whether the file's pauses are unique per step key of a tenant — a table written before #663,
 * which a pause of another tree with the same step key would hit.
 */
function isUniquePerTenantStepKey(connection: SqliteConnection): boolean {
  const { database } = connection;
  const columnsOf = (index: string): string =>
    database
      .prepare(`PRAGMA index_info("${index}")`)
      .all()
      .map((row) => IndexColumn.parse(row).name)
      .join(",");
  return database
    .prepare("PRAGMA index_list(pauses)")
    .all()
    .map((row) => IndexRow.parse(row))
    .some((index) => index.unique === 1 && columnsOf(index.name) === "tenant_id,step_key");
}

/** Migrates a file's pauses written by an older version (call inside a transaction): S107, then #663. */
export function migratePauses(connection: SqliteConnection): void {
  const columns = connection.columnsOf("pauses");
  if (columns.length > 0 && !columns.includes("resolved_at"))
    connection.database.exec(PAUSE_ANSWERS_MIGRATION);
  if (isUniquePerTenantStepKey(connection)) connection.database.exec(PAUSES_TREE_MIGRATION);
}
