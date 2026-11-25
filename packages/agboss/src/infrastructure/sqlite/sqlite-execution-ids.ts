import type { ExecutionIdentity } from "../execution-lease.repository.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/** One `INSERT … ON CONFLICT DO NOTHING`: whether a row was made — of two writers of a file, one. */
export function savedExecutionId(
  connection: SqliteConnection,
  { executionId, tenantId }: ExecutionIdentity,
): boolean {
  const { changes } = connection.database
    .prepare(
      `INSERT INTO execution_ids (execution_id, tenant_id) VALUES (?, ?)
       ON CONFLICT (execution_id) DO NOTHING`,
    )
    .run(executionId, tenantId);
  return Number(changes) === 1;
}
