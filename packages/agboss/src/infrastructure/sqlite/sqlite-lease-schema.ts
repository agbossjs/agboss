import type { SqliteConnection } from "./sqlite-connection.js";

/**
 * The leases' table — the fencing stores read it in their own `BEGIN IMMEDIATE` transactions
 * (#500) — with each tree's cancel mark on its row (#909, #1117: `cancel_requested_at`, set once by
 * the lease store's `requestCancel` and never cleared). The lease store and both fencing stores
 * create it and migrate a file an older version wrote (`ensureLeaseSchema`).
 */
export const EXECUTION_LEASES_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_leases (
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
  yielded INTEGER NOT NULL DEFAULT 0, cancel_requested_at INTEGER,
  PRIMARY KEY (tenant_id, root_execution_id));`;

/** The column of a yielded lease (#516), added to a file an older version wrote. */
const YIELDED_COLUMN = ["execution_leases", "yielded", "INTEGER NOT NULL DEFAULT 0"] as const;

/** The column of a tree's cancel mark (#1117), added to a file an older version wrote. */
const CANCEL_COLUMN = ["execution_leases", "cancel_requested_at", "INTEGER"] as const;

/** The table the marks lived in before #1117 (#909), moved onto the lease rows and dropped. */
const OLD_CANCEL_TABLE = "execution_cancel_requests";

/**
 * A mark of before onto its tree's lease row — a tree with no row gets a seed row: token 0,
 * released (1), never held — keeping a mark the row has already (`WHERE true`: SQLite's upsert
 * after a `SELECT`).
 */
const MOVED_MARKS = `INSERT INTO execution_leases (tenant_id, root_execution_id, holder_instance_id,
    lease_epoch, expires_at, released, yielded, cancel_requested_at)
  SELECT tenant_id, root_execution_id, '', 0, 0, 1, 0, requested_at FROM ${OLD_CANCEL_TABLE} WHERE true
  ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
    cancel_requested_at = COALESCE(execution_leases.cancel_requested_at, excluded.cancel_requested_at);
DROP TABLE ${OLD_CANCEL_TABLE};`;

/**
 * The leases' table on `connection`'s file, migrated: the columns an older version lacks added, and
 * (#1117) the marks of `execution_cancel_requests` moved onto the lease rows and that table dropped
 * — in one `BEGIN IMMEDIATE`, checked inside it, so of two connections one moves them and a run
 * again (or after a crash) finds nothing to do. Keyed by the file's shape, never by its stamp
 * (#1104).
 */
export function ensureLeaseSchema(connection: SqliteConnection): void {
  connection.ensureSchema("execution_leases", EXECUTION_LEASES_SCHEMA);
  connection.addColumn(...YIELDED_COLUMN);
  connection.addColumn(...CANCEL_COLUMN);
  connection.transaction(() => {
    if (connection.columnsOf(OLD_CANCEL_TABLE).length > 0) connection.database.exec(MOVED_MARKS);
  });
}
