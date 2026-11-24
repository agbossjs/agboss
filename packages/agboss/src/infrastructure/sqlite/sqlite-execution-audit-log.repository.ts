import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  ExecutionAuditLogRepository,
  type ExecutionAuditEventRecord,
} from "../execution-audit-log.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { parsedStoredJson } from "../stored-step.js";

const EventRow = z.object({ record: z.string() });

/** A row's record (written by `save`: the record as JSON). */
const recordOf = (row: unknown): ExecutionAuditEventRecord =>
  // the column holds exactly what `save` wrote
  parsedStoredJson(
    "execution audit event",
    EventRow.parse(row).record,
    {},
  ) as ExecutionAuditEventRecord;

/**
 * `ExecutionAuditLogRepository` on the application's SQLite file (#501): one row per event, its
 * record as JSON beside the columns it is found by, ordered by the time it happened and then by the
 * order it was saved. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteExecutionAuditLogRepository extends ExecutionAuditLogRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  save(record: ExecutionAuditEventRecord): Promise<void> {
    this.connection.database
      .prepare(
        `INSERT INTO execution_lease_events (tenant_id, root_execution_id, occurred_at, record)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        record.tenantId,
        record.rootExecutionId,
        Date.parse(record.occurredAt),
        JSON.stringify(record),
      );
    return Promise.resolve();
  }

  findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly ExecutionAuditEventRecord[]> {
    const rows = this.connection.database
      .prepare(
        `SELECT record FROM execution_lease_events WHERE tenant_id = ? AND root_execution_id = ?
         ORDER BY occurred_at, id`,
      )
      .all(tenantId, rootExecutionId);
    return Promise.resolve(rows.map(recordOf));
  }

  deleteExpired(cutoff: Date): Promise<number> {
    const { changes } = this.connection.database
      .prepare("DELETE FROM execution_lease_events WHERE occurred_at < ?")
      .run(cutoff.getTime());
    return Promise.resolve(Number(changes));
  }
}

sqliteImplementation(SqliteExecutionAuditLogRepository);
