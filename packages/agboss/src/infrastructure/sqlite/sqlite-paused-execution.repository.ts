import { z } from "zod";
import { decodePausedRun, encodePausedRun, type PausedExecution } from "../../app/paused-runs.js";
import { Injectable } from "../../components/decorators.js";
import { Clock } from "../clock.js";
import {
  PausedExecutionRepository,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "../paused-execution.repository.js";
import { cancelledPause, decidedPause, resolvedPause } from "../pause-record.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { migratePauses, PAUSES_SCHEMA, SqlitePauseRows } from "./sqlite-pause-rows.js";

/** One row per thread of a tenant (#261: the key is tenant + thread). */
const SCHEMA = `CREATE TABLE IF NOT EXISTS paused_executions (
  tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, run TEXT NOT NULL,
  workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, thread_id));`;

/**
 * The migration of a file written before tenants (#261, #265 S69 e): the table keyed by the thread
 * alone is rebuilt keyed by tenant + thread, its rows in the tenant `"default"`.
 */
const TENANT_MIGRATION = `ALTER TABLE paused_executions RENAME TO paused_executions_before_tenants;
${SCHEMA}
INSERT INTO paused_executions SELECT 'default', thread_id, run_id, run, workflow_version,
  config_hash, paused_at FROM paused_executions_before_tenants;
DROP TABLE paused_executions_before_tenants;`;

/**
 * The migration of a file written before pauses had records of their own (#267 S35): a thread's
 * pause kept its status and decision in its row; they now live in `pauses`, one row per pause.
 */
const PAUSE_RECORDS_MIGRATION = `ALTER TABLE paused_executions DROP COLUMN status;
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

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265 S32, #267 S35): one row per
 * thread of a tenant (#261) — the paused run and the versions it paused under — and one row per
 * pause (`pauses`). Every change of a pause is one `BEGIN IMMEDIATE` transaction, so of two resumes
 * on two instances exactly one records its decision. With `SqliteCheckpointSaver` a pause survives
 * a restart. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqlitePausedExecutionRepository extends PausedExecutionRepository {
  readonly #pauses: SqlitePauseRows;

  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    connection.transaction(() => {
      const columns = connection.columnsOf("paused_executions");
      if (columns.length > 0 && !columns.includes("tenant_id"))
        connection.database.exec(TENANT_MIGRATION);
      else if (columns.includes("status")) connection.database.exec(PAUSE_RECORDS_MIGRATION);
      migratePauses(connection);
    });
    connection.ensureSchema("paused_executions", SCHEMA);
    connection.ensureSchema("pauses", PAUSES_SCHEMA);
    this.#pauses = new SqlitePauseRows(connection.database);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    const row = this.connection.database
      .prepare("SELECT * FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .get(tenantId, threadId);
    return Promise.resolve(row === undefined ? undefined : toPausedExecution(row));
  }

  save(paused: PausedExecution): Promise<void> {
    const { run } = paused;
    this.connection.database
      .prepare("INSERT OR REPLACE INTO paused_executions VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        run.tenantId,
        run.threadId,
        run.runId,
        encodePausedRun(run),
        paused.workflowVersion,
        paused.configHash,
        this.clock.now().toISOString(),
      );
    return Promise.resolve();
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .run(tenantId, threadId);
    return Promise.resolve();
  }

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    const found = this.connection.transaction((): PauseRecord => {
      const stored = this.#pauses.findByStepKey(pause);
      if (stored !== undefined) return stored;
      this.#pauses.insert(pause);
      return pause;
    });
    return Promise.resolve(found);
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.#pauses.findById(tenantId, pauseId));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(this.#pauses.findAllByRoot(tenantId, rootExecutionId));
  }

  markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    return Promise.resolve(this.#pauses.markSent(tenantId, pauseId));
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    const resolved = this.connection.transaction(() =>
      this.#pauses.close(tenantId, pauseId, (pending) => resolvedPause(pending, answer, at)),
    );
    return Promise.resolve(resolved);
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const decided = this.connection.transaction(() =>
      this.#pauses.close(tenantId, pauseId, (pending) => decidedPause(pending, answer, at)),
    );
    return Promise.resolve(decided !== undefined);
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean> {
    const cancelled = this.connection.transaction(() =>
      this.#pauses.close(tenantId, pauseId, (pending) => cancelledPause(pending, resolution, at)),
    );
    return Promise.resolve(cancelled !== undefined);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    this.#pauses.markTaken(tenantId, pauseId);
    return Promise.resolve();
  }

  deleteByResolvedAtBefore(cutoff: Date): Promise<void> {
    this.#pauses.deleteByResolvedAtBefore(cutoff);
    return Promise.resolve();
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
