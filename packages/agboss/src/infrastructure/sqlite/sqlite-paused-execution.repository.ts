import { z } from "zod";
import type { PausedRun } from "../../app/paused-runs.js";
import { Injectable } from "../../components/decorators.js";
import type { AgentExecutionOutput } from "../../run/types.js";
import { Clock } from "../clock.js";
import {
  PausedExecutionRepository,
  PauseStatus,
  resolvedPause,
} from "../paused-execution.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/** One row per thread of a tenant (#261: the key is tenant + thread). */
const SCHEMA = `CREATE TABLE IF NOT EXISTS paused_executions (
  tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, run TEXT NOT NULL,
  workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL,
  decision TEXT, paused_at TEXT NOT NULL, PRIMARY KEY (tenant_id, thread_id));`;

/**
 * The migration of a file written before tenants (#261, #265 S69 e): the table keyed by the thread
 * alone is rebuilt keyed by tenant + thread, its rows in the tenant `"default"`.
 */
const TENANT_MIGRATION = `ALTER TABLE paused_executions RENAME TO paused_executions_before_tenants;
${SCHEMA}
INSERT INTO paused_executions SELECT 'default', thread_id, run_id, run, workflow_version,
  config_hash, status, decision, paused_at FROM paused_executions_before_tenants;
DROP TABLE paused_executions_before_tenants;`;

const PausedRow = z.object({
  run: z.string(),
  workflow_version: z.string(),
  config_hash: z.string(),
  status: z.enum(PauseStatus),
  decision: z.string().nullable(),
});

/** The fields a resume relies on; the rest of the stored run is passed through as written. */
const StoredRun = z.looseObject({
  status: z.literal("paused"),
  threadId: z.string(),
  // a run stored before tenants (#261) has none: it is the tenant "default"
  tenantId: z.string().optional(),
  runId: z.string(),
  ternId: z.string(),
  // Infinity when the run has no cost limit (z.number() rejects it)
  budgetUsd: z.custom<number>((value) => typeof value === "number" && !Number.isNaN(value)),
});

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

const decode = (text: string): unknown =>
  JSON.parse(text, (_key, item: unknown) => {
    const tagged = NonFinite.safeParse(item);
    return tagged.success ? Number(tagged.data.$number) : item;
  });

/** A decision as stored: JSON, or `NULL` for none. */
const encodedDecision = (decision: unknown): string | null =>
  decision === undefined ? null : encode(decision);

/** Whether a decoded run is what `save` wrote: an `AgentExecutionOutput` of a paused run. */
const isStoredRun = (value: unknown): value is AgentExecutionOutput =>
  StoredRun.safeParse(value).success;

function toPausedRun(row: unknown): PausedRun {
  const r = PausedRow.parse(row);
  const run = decode(r.run);
  if (!isStoredRun(run)) throw new Error(`a stored paused run is not readable: ${r.run}`);
  const tenantId: unknown = Reflect.get(run, "tenantId");
  const paused: PausedRun = {
    run: typeof tenantId === "string" ? run : { ...run, tenantId: "default" },
    workflowVersion: r.workflow_version,
    configHash: r.config_hash,
    status: r.status,
  };
  return r.decision === null ? paused : { ...paused, decision: decode(r.decision) };
}

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265, S32): one row per thread of a
 * tenant (#261) —
 * the paused run, the versions it paused under, its status and decision. `resolveByTenantIdAndThreadId` turns
 * `Pending` into `Resolved` in one `BEGIN IMMEDIATE` transaction, so of two resumes on two
 * instances exactly one records its decision. With `SqliteCheckpointSaver` a pause survives a
 * restart. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqlitePausedExecutionRepository extends PausedExecutionRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    connection.transaction(() => {
      const columns = connection.columnsOf("paused_executions");
      if (columns.length > 0 && !columns.includes("tenant_id"))
        connection.database.exec(TENANT_MIGRATION);
    });
    connection.ensureSchema("paused_executions", SCHEMA);
  }

  findByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<PausedRun | undefined> {
    const row = this.connection.database
      .prepare("SELECT * FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .get(tenantId, threadId);
    return Promise.resolve(row === undefined ? undefined : toPausedRun(row));
  }

  save(paused: PausedRun): Promise<void> {
    const { run } = paused;
    this.connection.database
      .prepare("INSERT OR REPLACE INTO paused_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        run.tenantId,
        run.threadId,
        run.runId,
        encode(run),
        paused.workflowVersion,
        paused.configHash,
        paused.status,
        encodedDecision(paused.decision),
        this.clock.now().toISOString(),
      );
    return Promise.resolve();
  }

  resolveByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
    decision: unknown,
  ): Promise<PausedRun | undefined> {
    const { database } = this.connection;
    const resolved = this.connection.transaction((): PausedRun | undefined => {
      const row = database
        .prepare(
          "SELECT * FROM paused_executions WHERE tenant_id = ? AND thread_id = ? AND status = ?",
        )
        .get(tenantId, threadId, PauseStatus.Pending);
      if (row === undefined) return undefined;
      database
        .prepare(
          "UPDATE paused_executions SET status = ?, decision = ? WHERE tenant_id = ? AND thread_id = ?",
        )
        .run(PauseStatus.Resolved, encodedDecision(decision), tenantId, threadId);
      return resolvedPause(toPausedRun(row), decision);
    });
    return Promise.resolve(resolved);
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM paused_executions WHERE tenant_id = ? AND thread_id = ?")
      .run(tenantId, threadId);
    return Promise.resolve();
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
