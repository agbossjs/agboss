/**
 * The leases' table — the fencing stores read it in their own `BEGIN IMMEDIATE` transactions
 * (#500) — with each tree's cancel mark on its row (#909, #1117: `cancel_requested_at`, set once by
 * the lease store's `requestCancel` and never cleared). `ensureBaselineSchema` creates it.
 */
export const EXECUTION_LEASES_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_leases (
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
  yielded INTEGER NOT NULL DEFAULT 0, cancel_requested_at INTEGER,
  stop_requested_at INTEGER, stop_mode TEXT,
  PRIMARY KEY (tenant_id, root_execution_id));`;
