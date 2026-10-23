import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  ExecutionHistoryRepository,
  type ExecutionHistoryPage,
  type ExecutionHistoryRecord,
} from "../execution-history.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS execution_history (
  tenant_id TEXT NOT NULL, execution_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, record TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_id));
CREATE INDEX IF NOT EXISTS execution_history_started ON execution_history (started_at, execution_id);
CREATE INDEX IF NOT EXISTS execution_history_thread ON execution_history (tenant_id, thread_id);
CREATE INDEX IF NOT EXISTS execution_history_ended ON execution_history (ended_at);`;

const Row = z.object({ record: z.string() });

const ORDER = "ORDER BY started_at, execution_id";

/** A row's record (written by `save`: the record as JSON). */
const recordOf = (row: unknown): ExecutionHistoryRecord =>
  // the column holds exactly what `save` wrote
  JSON.parse(Row.parse(row).record) as ExecutionHistoryRecord;

/**
 * `ExecutionHistoryRepository` on the application's SQLite file (#401 PR 1): one row per root
 * execution — its record as JSON beside the columns it is found by. A save replaces the row of its
 * tenant and execution. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteExecutionHistoryRepository extends ExecutionHistoryRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.ensureSchema("execution_history", SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  save(record: ExecutionHistoryRecord): Promise<void> {
    this.connection.database
      .prepare("INSERT OR REPLACE INTO execution_history VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        record.tenantId,
        record.executionId,
        record.threadId,
        record.startedAt,
        record.endedAt ?? null,
        JSON.stringify(record),
      );
    return Promise.resolve();
  }

  findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<ExecutionHistoryRecord | undefined> {
    const row = this.connection.database
      .prepare("SELECT record FROM execution_history WHERE tenant_id = ? AND execution_id = ?")
      .get(tenantId, executionId);
    return Promise.resolve(row === undefined ? undefined : recordOf(row));
  }

  findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(`SELECT record FROM execution_history WHERE execution_id = ? ${ORDER}`)
      .all(executionId);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT record FROM execution_history WHERE tenant_id = ? AND thread_id = ? ${ORDER}`,
      )
      .all(tenantId, threadId);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByTenantIdAndStartedAtBetween(
    tenantId: string,
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT record FROM execution_history WHERE tenant_id = ? AND started_at >= ? AND started_at < ? ${ORDER} LIMIT ? OFFSET ?`,
      )
      .all(tenantId, from.toISOString(), to.toISOString(), page.limit, page.offset);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByStartedAtBetween(
    from: Date,
    to: Date,
    page: ExecutionHistoryPage,
  ): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT record FROM execution_history WHERE started_at >= ? AND started_at < ? ${ORDER} LIMIT ? OFFSET ?`,
      )
      .all(from.toISOString(), to.toISOString(), page.limit, page.offset);
    return Promise.resolve(rows.map(recordOf));
  }

  deleteByEndedAtBefore(cutoff: Date): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM execution_history WHERE ended_at IS NOT NULL AND ended_at < ?")
      .run(cutoff.toISOString());
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteExecutionHistoryRepository);
