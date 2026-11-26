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
  expires_at TEXT, remind_at TEXT, target TEXT, seq INTEGER PRIMARY KEY AUTOINCREMENT,
  UNIQUE (tenant_id, pause_id), UNIQUE (tenant_id, root_execution_id, step_key));`;

/** #910: the deadline and reminder scans, and a tenant's pages; #1307e: the external reference's lookup (`seq` is the insertion sequence). */
export const PAUSES_INDEXES = `CREATE INDEX IF NOT EXISTS pauses_by_root ON pauses (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS pauses_by_resolved_at ON pauses (status, resolved_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_expiry ON pauses (status, expires_at);
CREATE INDEX IF NOT EXISTS pauses_pending_by_remind ON pauses (status, remind_at);
CREATE INDEX IF NOT EXISTS pauses_by_tenant ON pauses (tenant_id, status, target);
CREATE INDEX IF NOT EXISTS pauses_by_external_ref
  ON pauses ((CASE WHEN json_valid(pause) THEN json_extract(pause, '$.externalRef') END));
CREATE INDEX IF NOT EXISTS pauses_pending_unsent ON pauses (seq) WHERE status = 'pending' AND is_sent = 0;`;

/**
 * #1307e: who a pause is assigned to, one row per `(assignee, pause)` — what `listPauses({ assignee })`
 * reads on its primary key instead of scanning every pause's JSON. The triggers keep it equal to
 * the `assignees` of the pause's JSON on every insert, change and delete, so no repository writes it.
 */
export const PAUSE_ASSIGNEES_SCHEMA = `CREATE TABLE IF NOT EXISTS pause_assignees (
  assignee TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (assignee, seq)) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS pauses_assignees_insert AFTER INSERT ON pauses BEGIN
  INSERT OR IGNORE INTO pause_assignees (assignee, seq)
    SELECT j.value, NEW.seq FROM json_each(
      CASE WHEN json_valid(NEW.pause) THEN NEW.pause ELSE '{}' END, '$.assignees') j
    WHERE j.type = 'text';
END;
CREATE TRIGGER IF NOT EXISTS pauses_assignees_update AFTER UPDATE OF pause ON pauses BEGIN
  DELETE FROM pause_assignees WHERE seq = OLD.seq;
  INSERT OR IGNORE INTO pause_assignees (assignee, seq)
    SELECT j.value, NEW.seq FROM json_each(
      CASE WHEN json_valid(NEW.pause) THEN NEW.pause ELSE '{}' END, '$.assignees') j
    WHERE j.type = 'text';
END;
CREATE TRIGGER IF NOT EXISTS pauses_assignees_delete AFTER DELETE ON pauses BEGIN
  DELETE FROM pause_assignees WHERE seq = OLD.seq;
END;`;

export const PAUSES_SCHEMA = `${PAUSES_TABLE}\n${PAUSES_INDEXES}\n${PAUSE_ASSIGNEES_SCHEMA}`;

/** The paused runs of `SqlitePausedExecutionRepository`: one row per thread of a tenant (#261). */
export const PAUSED_RUNS_SCHEMA = `CREATE TABLE IF NOT EXISTS paused_executions (
  tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, run TEXT NOT NULL,
  workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, thread_id));`;

export const NOTICES_SCHEMA = `CREATE TABLE IF NOT EXISTS pause_notices (
  tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, recipient TEXT NOT NULL, notices TEXT NOT NULL,
  delivered INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
  head_written_at TEXT, is_dead INTEGER NOT NULL, problem TEXT, claim_token TEXT, claimed_until TEXT,
  PRIMARY KEY (tenant_id, pause_id, recipient));
CREATE INDEX IF NOT EXISTS pause_notices_due ON pause_notices (is_dead, next_attempt_at);`;
