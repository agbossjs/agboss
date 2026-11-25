import { StoreError, StoreErrorKind } from "../core/error-families/store-errors.js";
import type { InterruptMode } from "../app/interrupt-types.js";
import type { NewStatusTransition } from "../turns/index.js";
import type { Milliseconds } from "../units/index.js";
import type { ExecutionIdStore } from "./execution-id-store.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import {
  ClusterLeaseSyncOutcome,
  type ClusterLeaseCoordinator,
  type ClusterLeaseSync,
  type ClusterLeaseTake,
} from "./cluster-lease-types.js";
import {
  ExecutionLeaseRepository,
  type ExecutionIdentity,
  type ExecutionLease,
  type PauseMarks,
  type PauseRequest,
  type StopMark,
  type StoreDescriptor,
  type TreeMarks,
} from "./execution-lease.repository.js";

/**
 * Leases under `@ClusterStorage` (#1321e, D6). The cluster (Redis) decides who holds a tree's lease
 * and for how long; the **database's lease row** is the authority for everything a stale writer is
 * refused by: the tree's token, its stop mark, its external pause and the fence it raised. The
 * fencing stores check that row in their own transaction, so the row is written **before** the
 * cluster acknowledges anything, and a cluster that fails or loses its data can neither let a stale
 * token write nor hide a mark: every read of a mark is the database's, and every failure to mirror a
 * lease ends the call — fail closed.
 *
 * The cluster driver (`RedisExecutionLeaseRepository`) implements only `ClusterLeaseCoordinator`;
 * this module owns the order of the two writes. The database's lease store implements
 * `ClusterLeaseMirror` (it is the `ExecutionIdStore` of the application).
 */

/** How often a take re-asks the cluster after the database's row was ahead of its token. */
const CATCH_UP_ATTEMPTS = 3;

/**
 * `ExecutionLeaseRepository` over a cluster and a database (#1321e, D6): the lease's liveness is the
 * cluster's; its token, its stop mark, its external pause and the fence are the database row's, written first.
 *
 * - **A take** (`acquire`, `reclaim`) is mirrored in the row before it is handed out — a reclaim under an
 *   `Immediate` pause with the fence raised to its token in the same step; if the row cannot be
 *   written, or is ahead, the cluster's lease is given back and the call fails (`ClusterLeaseBehind`) —
 *   after the cluster has been raised past the row's token, a few times (`raiseEpoch`).
 * - **An end** (`release`, `retire`) is written to the row first; the cluster's key changes after.
 * - **A mark** (cancel, stop, pause, unpause) is written to the row (with its history row, in its
 *   transaction) and only then pushed to the cluster; a push that fails rejects the call **after** the
 *   mark is durable, and a repeat of the command pushes again. Every read of a mark is the row's.
 * - A renewal, a yield are the cluster's alone: the row has no expiry to renew.
 */
export class ClusterExecutionLeaseRepository extends ExecutionLeaseRepository {
  static override readonly store: StoreDescriptor = { backend: "cluster" };

  constructor(
    private readonly cluster: ClusterLeaseCoordinator,
    private readonly database: ExecutionIdStore,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.cluster.ping();
  }

  claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    return this.database.claimExecutionId(identity);
  }

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const tree = { tenantId, rootExecutionId };
    for (let attempt = 1; attempt <= CATCH_UP_ATTEMPTS; attempt += 1) {
      const lease = await this.cluster.acquire(tenantId, rootExecutionId, duration);
      if (lease === undefined) return undefined;
      const sync = await this.#mirrored(lease);
      if (sync.outcome === ClusterLeaseSyncOutcome.Synced) return lease;
      await this.cluster.release(lease);
      if (sync.outcome === ClusterLeaseSyncOutcome.Retired) return undefined;
      await this.cluster.raiseEpoch(tree, sync.rowToken);
    }
    throw this.#behind(tree);
  }

  renew(lease: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    return this.cluster.renew(lease, duration);
  }

  async release(lease: ExecutionLease): Promise<void> {
    await this.database.endClusterLease(lease, { isRetired: false });
    await this.cluster.release(lease);
  }

  async retire(lease: ExecutionLease): Promise<void> {
    await this.database.endClusterLease(lease, { isRetired: true });
    await this.cluster.retire(lease);
  }

  yield(lease: ExecutionLease): Promise<Milliseconds | undefined> {
    return this.cluster.yield(lease);
  }

  async reclaim(
    lease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await this.cluster.reclaim(lease, duration);
    if (taken === undefined) return undefined;
    // the row inherits an `Immediate` pause's fence in the mirror's own step (#1341c)
    const sync = await this.#mirrored(taken, { isReclaim: true });
    if (sync.outcome === ClusterLeaseSyncOutcome.Synced) return taken;
    await this.cluster.release(taken);
    if (sync.outcome === ClusterLeaseSyncOutcome.Retired) return undefined;
    throw this.#behind(lease);
  }

  async requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    await this.database.requestCancel(tree, transition);
    await this.#pushed(tree);
  }

  isCancelRequested(tree: ExecutionTree): Promise<boolean> {
    return this.database.isCancelRequested(tree);
  }

  async requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void> {
    await this.database.requestStop(tree, mode, transition);
    await this.#pushed(tree);
  }

  stopOf(tree: ExecutionTree): Promise<StopMark | undefined> {
    return this.database.stopOf(tree);
  }

  async requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void> {
    await this.database.requestPause(tree, request, transition);
    await this.#pushed(tree);
  }

  async unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    await this.database.unpause(tree, transition);
    await this.#pushed(tree);
  }

  pauseOf(tree: ExecutionTree): Promise<PauseMarks> {
    return this.database.pauseOf(tree);
  }

  override markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    return this.database.markedOf(tree);
  }

  /**
   * The lease written into the row. A row that cannot be written ends the call: the cluster's lease is
   * given back (best effort — it expires by itself otherwise) and the failure is the caller's.
   */
  async #mirrored(lease: ExecutionLease, take?: ClusterLeaseTake): Promise<ClusterLeaseSync> {
    try {
      return await this.database.syncClusterLease(lease, take);
    } catch (error) {
      await this.cluster.release(lease).catch(() => undefined);
      throw error;
    }
  }

  /** The tree's marks, as the row holds them now, pushed to the cluster. */
  async #pushed(tree: ExecutionTree): Promise<void> {
    await this.cluster.publishMarks(tree, await this.database.markedOf(tree));
  }

  #behind(tree: ExecutionTree): StoreError.ClusterLeaseBehind {
    return StoreError.of(StoreErrorKind.ClusterLeaseBehind, {
      message: `the cluster's lease of execution ${tree.rootExecutionId} stays behind the database's lease row: nothing is handed out`,
    });
  }
}

export * from "./cluster-lease-types.js";
