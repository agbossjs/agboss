import {
  CLUSTER_LEASE_EXPIRY,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
  type ClusterLeaseSync,
  type ClusterLeaseTake,
  type MirroredLease,
} from "./cluster-lease-types.js";
import { markOf } from "./in-memory-cancel-mark.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";
import { ExecutionLeaseRepository, type ExecutionLease } from "./execution-lease-contract.js";
import type { ClusterLeaseMirror } from "./cluster-lease-types.js";
import type { ExecutionTree } from "./execution-tree.repository.js";

/**
 * The in-memory lease store's mirror of a cluster's lease (#1321e): the row written in one
 * synchronous step, the marks kept, the token never lowered.
 */

/** Whether the row says `lease` is stale: a higher token, another holder at the token, or ended at it. */
function isBehind(
  row: { readonly lease: ExecutionLease; readonly released: boolean },
  lease: ExecutionLease,
): boolean {
  if (row.lease.token !== lease.token) return row.lease.token > lease.token;
  return row.lease.holderInstanceId !== lease.holderInstanceId || row.released;
}

/** Writes `lease` into its tree's row, held for good; refuses a stale one or a retired row. */
export function syncedInMemory(
  database: InMemoryDatabase,
  lease: ExecutionLease,
  take: ClusterLeaseTake = {},
): ClusterLeaseSync {
  const key = treeKeyOf(lease.tenantId, lease.rootExecutionId);
  const stored = database.executionLeases.get(key);
  if (stored?.isRetired === true) return { outcome: ClusterLeaseSyncOutcome.Retired };
  if (stored !== undefined && isBehind(stored, lease))
    return { outcome: ClusterLeaseSyncOutcome.Behind, rowToken: stored.lease.token };
  database.executionLeases.set(key, {
    lease: { ...lease, expiresAt: CLUSTER_LEASE_EXPIRY },
    released: false,
    // a reclaim under an `Immediate` pause: its token fenced in this same step (#1341c)
    ...markOf(stored, take.isReclaim === true ? lease.token : undefined),
  });
  return { outcome: ClusterLeaseSyncOutcome.Synced };
}

/** The tree's row as the fencing stores see it. */
export function mirroredInMemory(
  database: InMemoryDatabase,
  tree: ExecutionTree,
): MirroredLease | undefined {
  const stored = database.executionLeases.get(treeKeyOf(tree.tenantId, tree.rootExecutionId));
  if (stored === undefined) return undefined;
  const state =
    stored.isRetired === true
      ? MirroredLeaseState.Retired
      : stored.released
        ? MirroredLeaseState.Released
        : MirroredLeaseState.Held;
  return { token: stored.lease.token, holderInstanceId: stored.lease.holderInstanceId, state };
}

/**
 * The in-memory lease store's part that mirrors a cluster's lease (#1321e), the base of
 * `InMemoryExecutionLeaseRepository`: the row is the one `acquire` writes, so a mirrored lease is
 * the same row, held for good.
 */
export abstract class InMemoryClusterMirror
  extends ExecutionLeaseRepository
  implements ClusterLeaseMirror
{
  constructor(protected readonly database: InMemoryDatabase) {
    super();
  }

  syncClusterLease(lease: ExecutionLease, take?: ClusterLeaseTake): Promise<ClusterLeaseSync> {
    return Promise.resolve(syncedInMemory(this.database, lease, take));
  }

  async endClusterLease(
    lease: ExecutionLease,
    end: { readonly isRetired: boolean },
  ): Promise<void> {
    await (end.isRetired ? this.retire(lease) : this.release(lease));
  }

  mirroredLeaseOf(tree: ExecutionTree): Promise<MirroredLease | undefined> {
    return Promise.resolve(mirroredInMemory(this.database, tree));
  }
}
