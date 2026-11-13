import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decodePausedRun, encodePausedRun, type PausedExecution } from "../../app/paused-runs.js";

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

const PausedRow = z.object({
  // the row's own key columns: they name a run whose text cannot be parsed
  thread_id: z.string().optional(),
  run_id: z.string().optional(),
  run: z.string(),
  workflow_version: z.string(),
  config_hash: z.string(),
});

function toPausedExecution(row: unknown): PausedExecution {
  const r = PausedRow.parse(row);
  const run = decodePausedRun(r.run, { threadId: r.thread_id, runId: r.run_id });
  const tenantId: unknown = Reflect.get(run, "tenantId");
  return {
    run: typeof tenantId === "string" ? run : { ...run, tenantId: "default" },
    workflowVersion: r.workflow_version,
    configHash: r.config_hash,
  };
}

/** The statements of the paused runs, on one connection's database. */
export class SqlitePausedRunRows {
  constructor(private readonly database: DatabaseSync) {}

  find(tenantId: string, threadId: string): PausedExecution | undefined {
    const row = this.database
      .prepare("SELECT * FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .get(tenantId, threadId);
    return row === undefined ? undefined : toPausedExecution(row);
  }

  save(paused: PausedExecution, at: Date): void {
    const { run } = paused;
    this.database
      .prepare("INSERT OR REPLACE INTO paused_executions VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        run.tenantId,
        run.threadId,
        run.runId,
        encodePausedRun(run),
        paused.workflowVersion,
        paused.configHash,
        at.toISOString(),
      );
  }

  delete(tenantId: string, threadId: string): void {
    this.database
      .prepare("DELETE FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .run(tenantId, threadId);
  }

  /** Removes the thread's paused run only when it is `runId`'s: one statement. */
  deleteOfRun(tenantId: string, threadId: string, runId: string): void {
    this.database
      .prepare("DELETE FROM paused_executions WHERE tenant_id = ? AND thread_id = ? AND run_id = ?")
      .run(tenantId, threadId, runId);
  }
}
