import type { Milliseconds } from "../units/index.js";
import type { ExecutionLease, TreeMarks } from "./execution-lease-contract.js";
import type { ExecutionTree } from "./execution-tree.repository.js";

/**
 * The cluster lease vocabulary (#1321e, D6), apart from the composition in `cluster-lease.ts` so
 * that the stores that mirror a cluster's lease import it without a cycle through the contract.
 */

/**
 * Until when a mirrored cluster lease is live, as the row says it: never. The database cannot know
 * the cluster's expiry; the row stays at its token until the next take of the tree mirrors a higher
 * one, and every check of a lease (`expires_at > now`) passes for it unchanged. State `'c'`.
 */
export const CLUSTER_LEASE_EXPIRY = new Date(8_640_000_000_000_000);

/** The state of a mirrored lease row, as a fencing store reads it. */
export enum MirroredLeaseState {
  /** Held by the cluster's holder at the token. */
  Held = "held",
  /** Released by its holder (retire-before-expire: written before the cluster's key changed). */
  Released = "released",
  /** Retired for good: no later take of the tree gets a lease. */
  Retired = "retired",
}

/** What a tree's lease row says of the cluster's lease: its token, holder and state. */
export interface MirroredLease {
  readonly token: number;
  readonly holderInstanceId: string;
  readonly state: MirroredLeaseState;
}

/** How a mirror of a cluster lease ended. */
export enum ClusterLeaseSyncOutcome {
  /** The row now holds the lease (or already did). */
  Synced = "synced",
  /** The row is at a higher token (or at this token, another holder's): the lease is stale, nothing written. */
  Behind = "behind",
  /** The row is retired: no lease of this tree is given again, nothing written. */
  Retired = "retired",
}

/** The answer of `syncClusterLease`. */
export type ClusterLeaseSync =
  | { readonly outcome: ClusterLeaseSyncOutcome.Synced }
  | { readonly outcome: ClusterLeaseSyncOutcome.Behind; readonly rowToken: number }
  | { readonly outcome: ClusterLeaseSyncOutcome.Retired };

/**
 * What a database lease store does for the cluster's leases (#1321e): the rows a cluster's holder
 * is fenced by. Part of `ExecutionIdStore`, so a store that lacks one does not type-check as the
 * application's.
 */
export interface ClusterLeaseMirror {
  /**
   * Writes the cluster's `lease` into the tree's row — holder and token, live for good
   * (`CLUSTER_LEASE_EXPIRY`) — in one atomic step that keeps the row's marks (cancel, stop, pause and
   * the fence) and never lowers its token: refused as `Behind` when the row's token is above the
   * lease's (or equal with another holder), as `Retired` when the row is retired. Idempotent for the
   * same lease. A seed row (a mark before the first take) is taken over like a released one.
   */
  syncClusterLease(lease: ExecutionLease): Promise<ClusterLeaseSync>;
  /**
   * The holder's own end of the cluster's lease in the row — released, or retired for good —,
   * written **before** the cluster's key changes (retire-before-expire): another holder's row is
   * kept, nothing is retired by a mismatch. Idempotent; a retired row stays retired.
   */
  endClusterLease(lease: ExecutionLease, end: { readonly isRetired: boolean }): Promise<void>;
  /** The row as the fencing stores see it; `undefined` for a tree with no row (never taken, nothing marked). */
  mirroredLeaseOf(tree: ExecutionTree): Promise<MirroredLease | undefined>;
}

/**
 * What a cluster driver does: the lease's liveness (who holds it, until when) and the push of the
 * marks to the instances that watch them. None of it is an authority for a fence or a mark.
 */
export interface ClusterLeaseCoordinator {
  /** Whether the cluster answers: one fast round trip. */
  ping(): Promise<void>;
  /** The cluster's take: `undefined` while another holder's lease is valid; its token counts per tree. */
  acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined>;
  /** Extends the holder's lease; `undefined` once it is over. */
  renew(lease: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined>;
  /** Gives the lease up in the cluster. */
  release(lease: ExecutionLease): Promise<void>;
  /** Gives the lease up for good in the cluster: no later take. */
  retire(lease: ExecutionLease): Promise<void>;
  /** Marks the lease yielded. */
  yield(lease: ExecutionLease): Promise<Milliseconds | undefined>;
  /** The holder's take back at `token + 1`. */
  reclaim(lease: ExecutionLease, duration: Milliseconds): Promise<ExecutionLease | undefined>;
  /**
   * Raises the tree's token counter to at least `atLeast`, so that the next take is above it: how a
   * cluster that lost its counters (a flush, a failover to a stale replica) catches up with the
   * database's row. Never lowers it.
   */
  raiseEpoch(tree: ExecutionTree, atLeast: number): Promise<void>;
  /**
   * Pushes the tree's marks, as the database holds them, to the cluster: a cache and a signal (a
   * Pub/Sub message) that wake the holder — never read back as an authority. A repeated call pushes
   * again.
   */
  publishMarks(tree: ExecutionTree, marks: TreeMarks): Promise<void>;
}
