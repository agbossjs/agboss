import type { SqliteConnection } from "./sqlite-connection.js";

/**
 * The pauses of `SqlitePausedExecutionRepository` (#267 S35): one row per pause, unique per step
 * key of a tree (#663); every change of a pending pause is one conditional `UPDATE … WHERE status =
 * 'pending'`, so of two connections exactly one changes it.
 */

/** #663: unique per step key of a tree — a step key names no tree, so another tree's never matches. */
export const PAUSES_TABLE = `CREATE TABLE IF NOT EXISTS pauses (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
  root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
  pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
  expires_at TEXT, remind_at TEXT, channel TEXT,
  PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`;

/** #910: the deadline and reminder scans, and a tenant's pages (`rowid` is the insertion sequence). */
export const PAUSES_INDEXES = `CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_expiry ON pauses (status, expires_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_remind ON pauses (status, remind_at);
CREATE INDEX IF NOT EXISTS pauses_by_tenant ON pauses (tenant_id, status, channel);`;

export const PAUSES_SCHEMA = `${PAUSES_TABLE}\n${PAUSES_INDEXES}`;

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
const PAUSE_KIND_MIGRATION = `UPDATE pauses SET pause = json_set(json_remove(pause, '$.agent'), '$.step', json_extract(pause, '$.agent'),
    '$.kind', CASE json_extract(pause, '$.component.kind') WHEN 'question' THEN 'question' ELSE 'approval' END)
  WHERE json_valid(pause) AND json_type(pause, '$.kind') IS NULL AND json_type(pause, '$.agent') = 'text';`;

/**
 * #910: a pause's deadline, reminder and channel get columns of their own (the scans and a tenant's
 * pages read them); `channel` is backfilled from the record's JSON, `expires_at` and `remind_at`
 * are empty — no pause stored before had a deadline.
 */
const PAUSE_EXPIRY_MIGRATION = `ALTER TABLE pauses ADD COLUMN expires_at TEXT;
ALTER TABLE pauses ADD COLUMN remind_at TEXT;
ALTER TABLE pauses ADD COLUMN channel TEXT;`;
const PAUSE_CHANNEL_BACKFILL = `UPDATE pauses SET channel = json_extract(pause, '$.channel') WHERE channel IS NULL;`;

/** Migrates a file's pauses written by an older version (inside a transaction): S107, #663, 0.1.1, #910. */
export function migratePauses(connection: SqliteConnection): void {
  const columns = connection.columnsOf("pauses");
  migrateBeforeDeadlines(connection, columns);
  // the table is rebuilt or altered above: a file that had no `channel` column gets it filled
  if (columns.length > 0 && !columns.includes("channel")) {
    if (!connection.columnsOf("pauses").includes("expires_at"))
      connection.database.exec(PAUSE_EXPIRY_MIGRATION);
    connection.database.exec(PAUSE_CHANNEL_BACKFILL);
  }
}

/** The migrations of files written before deadlines (S107, #663, 0.1.1). */
function migrateBeforeDeadlines(connection: SqliteConnection, columns: readonly string[]): void {
  if (columns.length > 0 && !columns.includes("resolved_at"))
    connection.database.exec(PAUSE_ANSWERS_MIGRATION);
  // #663: unique per step key of a tenant — a pause of another tree with that step key hits it
  if (connection.uniqueIndexesOf("pauses").includes("tenant_id,step_key"))
    connection.database.exec(PAUSES_TREE_MIGRATION);
  if (columns.length > 0) connection.database.exec(PAUSE_KIND_MIGRATION);
}

/** The paused runs of `SqlitePausedExecutionRepository`: one row per thread of a tenant (#261). */
export const PAUSED_RUNS_SCHEMA = `CREATE TABLE IF NOT EXISTS paused_executions (
  tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, run TEXT NOT NULL,
  workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, thread_id));`;

/**
 * The migration of a file written before tenants (#261, #265 S69 e): the table keyed by the thread
 * alone is rebuilt keyed by tenant + thread, its rows in the tenant `"default"`.
 */
export const TENANT_MIGRATION = `ALTER TABLE paused_executions RENAME TO paused_executions_before_tenants;
${PAUSED_RUNS_SCHEMA}
INSERT INTO paused_executions SELECT 'default', thread_id, run_id, run, workflow_version,
  config_hash, paused_at FROM paused_executions_before_tenants;
DROP TABLE paused_executions_before_tenants;`;

/**
 * The migration of a file written before pauses had records of their own (#267 S35): a thread's
 * pause kept its status and decision in its row; they now live in `pauses`, one row per pause.
 */
export const PAUSE_RECORDS_MIGRATION = `ALTER TABLE paused_executions DROP COLUMN status;
ALTER TABLE paused_executions DROP COLUMN decision;`;

export const NOTICES_SCHEMA = `CREATE TABLE IF NOT EXISTS pause_notices (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, recipient TEXT NOT NULL, notices TEXT NOT NULL,
  delivered INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
  head_written_at TEXT, is_dead INTEGER NOT NULL, problem TEXT, claim_token TEXT, claimed_until TEXT,
  PRIMARY KEY (tenant_id, pause_id, recipient));
CREATE INDEX IF NOT EXISTS pause_notices_due ON pause_notices (is_dead, next_attempt_at);`;

/**
 * Makes the file's pause tables and migrates a file an older version wrote — at construction, in one
 * transaction, as every SQLite store does (the logic behind it loads later, and never opens a
 * transaction of its own to make a table).
 */
export function preparePauseTables(connection: SqliteConnection): void {
  connection.transaction(() => {
    const columns = connection.columnsOf("paused_executions");
    if (columns.length > 0 && !columns.includes("tenant_id"))
      connection.database.exec(TENANT_MIGRATION);
    else if (columns.includes("status")) connection.database.exec(PAUSE_RECORDS_MIGRATION);
    migratePauses(connection);
  });
  connection.ensureSchema("paused_executions", PAUSED_RUNS_SCHEMA);
  connection.ensureSchema("pauses", PAUSES_SCHEMA);
  connection.ensureSchema("pause_notices", NOTICES_SCHEMA);
}
