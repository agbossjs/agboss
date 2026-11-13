import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decodePausedRun, encodePausedRun, type PausedExecution } from "../../app/paused-runs.js";

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
