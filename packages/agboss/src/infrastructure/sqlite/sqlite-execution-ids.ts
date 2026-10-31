import type { ExecutionIdentity } from "../execution-lease.repository.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/**
 * Every execution id handed out (#591), by the id alone, in the lease store's file: inserted once,
 * never removed. A file an older version wrote gets the table with the ids its leases name — roots
 * and `AnyInstance` children; a `ParentInstance` child of before has no row of its own anywhere.
 */
const EXECUTION_IDS_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_ids (
  execution_id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);`;

/** The ids of the trees a file of an older version holds, from their leases (`WHERE true`: SQLite's upsert after a `SELECT`). */
const EXECUTION_IDS_FROM_LEASES = `INSERT INTO execution_ids (execution_id, tenant_id)
  SELECT root_execution_id, tenant_id FROM execution_leases WHERE true
  ON CONFLICT (execution_id) DO NOTHING;`;

/** Creates `execution_ids` (after `execution_leases`), filled from the leases when it is new. */
export function ensureExecutionIdsSchema(connection: SqliteConnection): void {
  const isNew = connection.columnsOf("execution_ids").length === 0;
  const fromLeases = isNew ? EXECUTION_IDS_FROM_LEASES : "";
  connection.ensureSchema("execution_ids", `${EXECUTION_IDS_SCHEMA}${fromLeases}`);
}

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
