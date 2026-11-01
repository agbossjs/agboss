import type { ExecutionIdentity } from "../execution-lease.repository.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/**
 * Every execution id handed out (#591), by the id alone, in the lease store's file: inserted once,
 * never removed — loaded on the first new execution's id, so the root import stays as it was. Made
 * then, before the first id is kept; a file an older version wrote gets the table with the ids its leases name — roots
 * and `AnyInstance` children — and (#638) every execution its outbound calls name, a `ParentInstance`
 * child's too: its step-keyed call sent `<executionId>:<node>:<visit>:<name>` to the other system,
 * which would answer a new execution of that id with the old call's response.
 */
const EXECUTION_IDS_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_ids (
  execution_id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);`;

/** The ids of the trees a file of an older version holds, from their leases (`WHERE true`: SQLite's upsert after a `SELECT`). */
const EXECUTION_IDS_FROM_LEASES = `INSERT INTO execution_ids (execution_id, tenant_id)
  SELECT root_execution_id, tenant_id FROM execution_leases WHERE true
  ON CONFLICT (execution_id) DO NOTHING;`;

/** #638: the executions of a file of before that made an outbound call, whatever their lease. */
const EXECUTION_IDS_FROM_OUTBOUND_CALLS = `INSERT INTO execution_ids (execution_id, tenant_id)
  SELECT json_extract(record, '$.executionId'), tenant_id FROM outbound_calls
  WHERE json_extract(record, '$.executionId') IS NOT NULL
  ON CONFLICT (execution_id) DO NOTHING;`;

/** What a new table is filled with: the leases' ids, and the outbound calls' when the file has them. */
const fillOf = (connection: SqliteConnection): string =>
  connection.columnsOf("outbound_calls").length === 0
    ? EXECUTION_IDS_FROM_LEASES
    : `${EXECUTION_IDS_FROM_LEASES}${EXECUTION_IDS_FROM_OUTBOUND_CALLS}`;

/** The connections whose file has `execution_ids` already. */
const ready = new WeakSet<SqliteConnection>();

/** Creates `execution_ids` (after `execution_leases`), filled from the leases when it is new. */
function ensureExecutionIdsSchema(connection: SqliteConnection): void {
  if (ready.has(connection)) return;
  const isNew = connection.columnsOf("execution_ids").length === 0;
  const fromBefore = isNew ? fillOf(connection) : "";
  connection.ensureSchema("execution_ids", `${EXECUTION_IDS_SCHEMA}${fromBefore}`);
  ready.add(connection);
}

/** One `INSERT … ON CONFLICT DO NOTHING`: whether a row was made — of two writers of a file, one. */
export function savedExecutionId(
  connection: SqliteConnection,
  { executionId, tenantId }: ExecutionIdentity,
): boolean {
  ensureExecutionIdsSchema(connection);
  const { changes } = connection.database
    .prepare(
      `INSERT INTO execution_ids (execution_id, tenant_id) VALUES (?, ?)
       ON CONFLICT (execution_id) DO NOTHING`,
    )
    .run(executionId, tenantId);
  return Number(changes) === 1;
}
