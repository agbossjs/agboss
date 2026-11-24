import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  ExecutionHistoryRepository,
  type ExecutionHistoryQuery,
  type TenantExecutionHistoryQuery,
  type ExecutionHistoryRecord,
} from "../execution-history.repository.js";
import type { Page } from "../../app/page.js";
import { listingWindowOf, pageOfWindow } from "../listing-window.js";
import { executionHistoryRecordOfJson } from "../stored-history.js";
import { parsedStoredJson } from "../stored-step.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const Row = z.object({ execution_id: z.string().optional(), record: z.string() });

const ORDER = "ORDER BY started_at, execution_id";

/** A row's record (written by `save`: the record as JSON, or 0.1.0's: its pauses read with the new names, #934). */
const recordOf = (row: unknown): ExecutionHistoryRecord => {
  const { execution_id: executionId, record } = Row.parse(row);
  return executionHistoryRecordOfJson(
    parsedStoredJson({ what: "execution history record", text: record, ids: { executionId } }),
  );
};

/**
 * `ExecutionHistoryRepository` on the application's SQLite file (#401 PR 1): one row per root
 * execution — its record as JSON beside the columns it is found by. A save replaces the row of its
 * tenant and execution. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteExecutionHistoryRepository extends ExecutionHistoryRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
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
      .prepare(
        "SELECT execution_id, record FROM execution_history WHERE tenant_id = ? AND execution_id = ?",
      )
      .get(tenantId, executionId);
    return Promise.resolve(row === undefined ? undefined : recordOf(row));
  }

  findAllByExecutionId(executionId: string): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(`SELECT execution_id, record FROM execution_history WHERE execution_id = ? ${ORDER}`)
      .all(executionId);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<ExecutionHistoryRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT execution_id, record FROM execution_history WHERE tenant_id = ? AND thread_id = ? ${ORDER}`,
      )
      .all(tenantId, threadId);
    return Promise.resolve(rows.map(recordOf));
  }

  findAllByTenantIdAndStartedAtBetween(
    query: TenantExecutionHistoryQuery,
  ): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const rows = this.connection.database
      .prepare(
        `SELECT execution_id, record FROM execution_history WHERE tenant_id = ? AND started_at >= ? AND started_at < ? ${ORDER} LIMIT ? OFFSET ?`,
      )
      .all(
        query.tenantId,
        query.from.toISOString(),
        query.to.toISOString(),
        window.limit + 1,
        window.offset,
      );
    return Promise.resolve(pageOfWindow(rows.map(recordOf), window));
  }

  findAllByStartedAtBetween(query: ExecutionHistoryQuery): Promise<Page<ExecutionHistoryRecord>> {
    const window = listingWindowOf(query);
    const rows = this.connection.database
      .prepare(
        `SELECT execution_id, record FROM execution_history WHERE started_at >= ? AND started_at < ? ${ORDER} LIMIT ? OFFSET ?`,
      )
      .all(query.from.toISOString(), query.to.toISOString(), window.limit + 1, window.offset);
    return Promise.resolve(pageOfWindow(rows.map(recordOf), window));
  }

  deleteExpired(cutoff: Date): Promise<number> {
    const { changes } = this.connection.database
      .prepare("DELETE FROM execution_history WHERE ended_at IS NOT NULL AND ended_at < ?")
      .run(cutoff.toISOString());
    return Promise.resolve(Number(changes));
  }
}

sqliteImplementation(SqliteExecutionHistoryRepository);
