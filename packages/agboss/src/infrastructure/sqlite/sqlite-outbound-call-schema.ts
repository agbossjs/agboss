/**
 * The `outbound_calls` table (#505, #825). `seq` is the row's place in the record order — an
 * `INTEGER PRIMARY KEY AUTOINCREMENT`, so the rowid is declared: `VACUUM` or a dump and restore
 * keep it, and no number is given twice, even after the highest row is pruned. The paged listing
 * reads by it.
 */
const OUTBOUND_CALLS_TABLE = `
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

export const OUTBOUND_CALLS_SCHEMA = `${OUTBOUND_CALLS_TABLE}${INDEXES}`;

/** The columns an intent is written with: `seq` is the table's to give. */
export const OUTBOUND_CALL_COLUMNS =
  "scope_key, idempotency_key, name, tenant_id, root_execution_id, status, ended_at, record, business_key";
