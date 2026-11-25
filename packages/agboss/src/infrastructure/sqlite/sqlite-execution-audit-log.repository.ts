import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  ExecutionAuditLogRepository,
  type EndedTree,
  type ExecutionAuditEventRecord,
} from "../execution-audit-log.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { parsedStoredJson } from "../stored-step.js";

const EventRow = z.object({ record: z.string() });
const TreeRow = z.object({ tenant_id: z.string(), root_execution_id: z.string() });

/** A row's record (written by `save`: the record as JSON). */
const recordOf = (row: unknown): ExecutionAuditEventRecord =>
  // the column holds exactly what `save` wrote
  parsedStoredJson({
    what: "execution audit event",
    text: EventRow.parse(row).record,
  }) as ExecutionAuditEventRecord;

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

  async deleteExpired(cutoff: Date, isEnded: EndedTree): Promise<number> {
    const { database } = this.connection;
    const trees = database
      .prepare(
        `SELECT DISTINCT tenant_id, root_execution_id FROM execution_lease_events
         WHERE occurred_at < ?`,
      )
      .all(cutoff.getTime())
      .map((row) => TreeRow.parse(row));
    const removal = database.prepare(
      `DELETE FROM execution_lease_events
       WHERE tenant_id = ? AND root_execution_id = ? AND occurred_at < ?`,
    );
    let removed = 0;
    for (const { tenant_id: tenantId, root_execution_id: rootExecutionId } of trees) {
      // an ended tree stays ended: asked before its rows go, never a live tree's are removed
      if (!(await isEnded({ tenantId, rootExecutionId }))) continue;
      // after the await the gate no longer covers this call: each removal is served again
      removed += await this.connection.serve(() =>
        Number(removal.run(tenantId, rootExecutionId, cutoff.getTime()).changes),
      );
    }
    return removed;
  }
}

sqliteImplementation(SqliteExecutionAuditLogRepository);
