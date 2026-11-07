import { inImmediateTransaction, type SqliteConnection } from "./sqlite-connection.js";

/**
 * The `outbound_calls` table (#505, #825). `seq` is the row's place in the record order — an
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, so the rowid is declared: `VACUUM` or a dump and restore
 * keep it, and no number is given twice, even after the highest row is pruned. The paged listing
 * reads by it.
 */
const TABLE = `
CREATE TABLE IF NOT EXISTS outbound_calls (
  scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, status TEXT NOT NULL,
  ended_at INTEGER, record TEXT NOT NULL, business_key TEXT,
  seq INTEGER PRIMARY KEY AUTOINCREMENT);`;

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_step
  ON outbound_calls (scope_key, idempotency_key, name) WHERE business_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outbound_calls_by_business_key
  ON outbound_calls (tenant_id, name, business_key) WHERE business_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbound_calls_by_tree ON outbound_calls (tenant_id, root_execution_id);
CREATE INDEX IF NOT EXISTS outbound_calls_by_status ON outbound_calls (tenant_id, status, seq);`;

export const OUTBOUND_CALLS_SCHEMA = `${TABLE}${INDEXES}`;

/** The columns an intent is written with: `seq` is the table's to give. */
export const OUTBOUND_CALL_COLUMNS =
  "scope_key, idempotency_key, name, tenant_id, root_execution_id, status, ended_at, record, business_key";

/**
 * A file whose `outbound_calls` was written before `seq` (#825): the table rebuilt with it, its rows
 * in their rowid order, in one transaction. Its indexes go with the old table; the store's schema
 * makes them again on the new one right after.
 */
export function upgradeOutboundCallsSeq(connection: SqliteConnection): void {
  const columns = connection.columnsOf("outbound_calls");
  if (columns.length === 0 || columns.includes("seq")) return;
  const database = connection.database;
  inImmediateTransaction(database, () => {
    database.exec("ALTER TABLE outbound_calls RENAME TO outbound_calls_before_seq");
    database.exec(TABLE);
    database.exec(
      `INSERT INTO outbound_calls (${OUTBOUND_CALL_COLUMNS}) SELECT ${OUTBOUND_CALL_COLUMNS} FROM outbound_calls_before_seq ORDER BY rowid`,
    );
    database.exec("DROP TABLE outbound_calls_before_seq");
  });
}
