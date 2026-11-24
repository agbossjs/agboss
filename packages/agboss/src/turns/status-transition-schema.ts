/** The DDL of `thread_status_transitions`: keyed and indexed by `(tenant_id, thread_id, seq)`. */
export const STATUS_TRANSITIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS thread_status_transitions (
  tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, from_status TEXT,
  to_status TEXT NOT NULL, trigger TEXT NOT NULL, reason TEXT, actor TEXT, lease_token INTEGER,
  at TEXT NOT NULL, PRIMARY KEY (tenant_id, thread_id, seq));`;
