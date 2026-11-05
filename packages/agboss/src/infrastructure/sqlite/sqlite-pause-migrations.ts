import type { SqliteConnection } from "./sqlite-connection.js";
import { PAUSES_INDEXES, PAUSES_TABLE } from "./sqlite-pause-rows.js";

/** The migrations of a file's pauses written by an older version. */

/**
 * #663: a file whose pauses were unique per step key of a tenant — the table rebuilt unique per
 * step key of a tree, its rows in their order (`findAllByRoot` reads by `rowid`). Its indexes
 * follow the renamed table and go with it; they are made again on the new one.
 */
const PAUSE_COLUMNS = `tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer,
  resolution, resolved_at`;
const PAUSES_TREE_MIGRATION = `ALTER TABLE pauses RENAME TO pauses_before_trees;
${PAUSES_TABLE}
INSERT INTO pauses (${PAUSE_COLUMNS}) SELECT ${PAUSE_COLUMNS} FROM pauses_before_trees ORDER BY rowid;
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

/**
 * 0.1.1: a pause stores its `kind` and names its `step` (`agent` before). A row written before is
 * rewritten once, by the rule it was written under: a question role's component is a question,
 * every other pause an approval (an approval's row from before components, #268 S93, too). Rows
 * that have a `kind` are left as they are, so it runs at every open and changes a file once; a row
 * that is not JSON is left to fail its own read. A file opened by 0.1.1 is not read by 0.1.0 again.
 */
const PAUSE_KIND_MIGRATION = `UPDATE pauses SET pause = json_set(json_remove(pause, '$.agent'),
    '$.step', json_extract(pause, '$.agent'),
    '$.kind', CASE json_extract(pause, '$.component.kind') WHEN 'question' THEN 'question' ELSE 'approval' END)
  WHERE json_valid(pause) AND json_type(pause, '$.kind') IS NULL AND json_type(pause, '$.agent') = 'text';`;

/** Migrates a file's pauses written by an older version (inside a transaction): S107, #663, 0.1.1. */
export function migratePauses(connection: SqliteConnection): void {
  const columns = connection.columnsOf("pauses");
  if (columns.length > 0 && !columns.includes("resolved_at"))
    connection.database.exec(PAUSE_ANSWERS_MIGRATION);
  // #663: unique per step key of a tenant — a pause of another tree with that step key hits it
  if (connection.uniqueIndexesOf("pauses").includes("tenant_id,step_key"))
    connection.database.exec(PAUSES_TREE_MIGRATION);
  if (columns.length > 0) connection.database.exec(PAUSE_KIND_MIGRATION);
}
