import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  CLUSTER_LEASE_EXPIRY,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
  type ClusterLeaseSync,
  type ClusterLeaseTake,
  type MirroredLease,
} from "../cluster-lease-types.js";
import { ExecutionLeaseRepository, type ExecutionLease } from "../execution-lease-contract.js";
import type { ClusterLeaseMirror } from "../cluster-lease-types.js";
import type { SqliteConnection } from "./sqlite-connection.js";
import { reclaimedFenceSql } from "./sqlite-pause.js";
import type { ExecutionTree } from "../execution-tree.repository.js";

/**
 * The SQLite lease store's mirror of a cluster's lease (#1321e): the row `released` as 0 held, 1
 * released, 3 retired (#520) — a mirrored lease is held with `expires_at` at `CLUSTER_LEASE_EXPIRY`,
 * so every check of a lease (`expires_at > now`) passes for it unchanged.
 */

const RETIRED = 3;

const Row = z.object({
  holder_instance_id: z.string(),
  lease_epoch: z.number(),
  released: z.number(),
});

const readRow = (database: DatabaseSync, tree: ExecutionTree) => {
  const row = database
    .prepare("SELECT * FROM execution_leases WHERE tenant_id = ? AND root_execution_id = ?")
    .get(tree.tenantId, tree.rootExecutionId);
  return row === undefined ? undefined : Row.parse(row);
};

/** Whether the row says `lease` is stale: a higher token, another holder at the token, or ended at it. */
function isBehind(row: z.infer<typeof Row>, lease: ExecutionLease): boolean {
  if (row.lease_epoch !== lease.token) return row.lease_epoch > lease.token;
  return row.holder_instance_id !== lease.holderInstanceId || row.released !== 0;
}

/** Writes `lease` into its tree's row (inside the caller's transaction); refuses a stale one or a retired row. */
export function syncedOnSqlite(
  database: DatabaseSync,
  lease: ExecutionLease,
  take: ClusterLeaseTake = {},
): ClusterLeaseSync {
  const stored = readRow(database, lease);
  if (stored?.released === RETIRED) return { outcome: ClusterLeaseSyncOutcome.Retired };
  if (stored !== undefined && isBehind(stored, lease))
    return { outcome: ClusterLeaseSyncOutcome.Behind, rowToken: stored.lease_epoch };
  // a reclaim under an `Immediate` pause: its token fenced in this same statement (#1341c)
  const fence =
    take.isReclaim === true
      ? `, ${reclaimedFenceSql("excluded.lease_epoch", "execution_leases.")}`
      : "";
  database
    .prepare(
      `INSERT INTO execution_leases (tenant_id, root_execution_id,
       holder_instance_id, lease_epoch, expires_at, released, yielded)
       VALUES (?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT (tenant_id, root_execution_id) DO UPDATE SET
         holder_instance_id = excluded.holder_instance_id, lease_epoch = excluded.lease_epoch,
         expires_at = excluded.expires_at, released = 0, yielded = 0${fence}`,
    )
    .run(
      lease.tenantId,
      lease.rootExecutionId,
      lease.holderInstanceId,
      lease.token,
      CLUSTER_LEASE_EXPIRY.getTime(),
    );
  return { outcome: ClusterLeaseSyncOutcome.Synced };
}

/** The tree's row as the fencing stores see it. */
export function mirroredOnSqlite(
  database: DatabaseSync,
  tree: ExecutionTree,
): MirroredLease | undefined {
  const stored = readRow(database, tree);
  if (stored === undefined) return undefined;
  let state = MirroredLeaseState.Released;
  if (stored.released === RETIRED) state = MirroredLeaseState.Retired;
  else if (stored.released === 0) state = MirroredLeaseState.Held;
  return { token: stored.lease_epoch, holderInstanceId: stored.holder_instance_id, state };
}

/**
 * The SQLite lease store's part that mirrors a cluster's lease (#1321e), the base of
 * `SqliteExecutionLeaseRepository`: one `BEGIN IMMEDIATE` like every fenced method.
 */
export abstract class SqliteClusterMirror
  extends ExecutionLeaseRepository
  implements ClusterLeaseMirror
{
  constructor(protected readonly connection: SqliteConnection) {
    super();
  }

  syncClusterLease(lease: ExecutionLease, take?: ClusterLeaseTake): Promise<ClusterLeaseSync> {
    return Promise.resolve(
      this.connection.transaction(() => syncedOnSqlite(this.connection.database, lease, take)),
    );
  }

  async endClusterLease(
    lease: ExecutionLease,
    end: { readonly isRetired: boolean },
  ): Promise<void> {
    await (end.isRetired ? this.retire(lease) : this.release(lease));
  }

  mirroredLeaseOf(tree: ExecutionTree): Promise<MirroredLease | undefined> {
    return Promise.resolve(mirroredOnSqlite(this.connection.database, tree));
  }
}
