import type { Milliseconds } from "../units/index.js";
import type { ClusterLeaseCoordinator } from "./cluster-lease-types.js";
import {
  remainingOf,
  takenOverFromOf,
  type ExecutionLease,
  type TreeMarks,
} from "./execution-lease-contract.js";
import type { ExecutionTree } from "./execution-tree.repository.js";
import { treeKeyOf } from "./in-memory-database.js";

/** One tree's cluster state: its lease as the cluster holds it, its token counter and its pushed marks. */
interface ClusterRow {
  lease: ExecutionLease | undefined;
  counter: number;
  isReleased: boolean;
  isRetired: boolean;
  marks: TreeMarks | undefined;
}

/** What `InMemoryCluster` can be made to do wrong, for the tests of the fail-closed paths. */
export interface ClusterOutage {
  /** Every call rejects while set (the cluster is down). */
  isDown: boolean;
  /** The cluster forgets its counters (a flush): the next take starts again from 1. */
  forgetCounters(): void;
}

/**
 * The cluster as a double (#1321e): the lease liveness of a Redis-like store in memory, the one the
 * core's unit tests and a store package's first contract run use. It decides expiry by the clock it
 * is given and counts tokens per tree; it is no authority for a fence, a stop or a pause — it keeps
 * only what was pushed to it (`pushedMarksOf`), which is how a test sees that a mark is a cache.
 * Several instances share one `InMemoryCluster`; each takes its own `coordinatorOf(instanceId)`.
 */
export class InMemoryCluster implements ClusterOutage {
  isDown = false;
  readonly #rows = new Map<string, ClusterRow>();

  constructor(private readonly now: () => Date) {}

  forgetCounters(): void {
    this.#rows.clear();
  }

  /** The marks last pushed for the tree, `undefined` before any push. */
  pushedMarksOf(tree: ExecutionTree): TreeMarks | undefined {
    return this.#rows.get(treeKeyOf(tree.tenantId, tree.rootExecutionId))?.marks;
  }

  /** The coordinator of one instance. */
  coordinatorOf(instanceId: string): ClusterLeaseCoordinator {
    return new InMemoryClusterCoordinator(this, instanceId);
  }

  /** @internal */
  row(tree: ExecutionTree): ClusterRow {
    const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
    const found = this.#rows.get(key);
    if (found !== undefined) return found;
    const row: ClusterRow = {
      lease: undefined,
      counter: 0,
      isReleased: true,
      isRetired: false,
      marks: undefined,
    };
    this.#rows.set(key, row);
    return row;
  }

  /** @internal */
  clock(): Date {
    return this.now();
  }

  /** @internal */
  assertUp(): void {
    if (this.isDown) throw new Error("the cluster is down");
  }
}

const isLive = (row: ClusterRow, now: Date): boolean =>
  !row.isReleased && row.lease !== undefined && row.lease.expiresAt.getTime() > now.getTime();

const isSame = (row: ClusterRow, lease: ExecutionLease): boolean =>
  row.lease?.token === lease.token && row.lease.holderInstanceId === lease.holderInstanceId;

class InMemoryClusterCoordinator implements ClusterLeaseCoordinator {
  constructor(
    private readonly cluster: InMemoryCluster,
    private readonly instanceId: string,
  ) {}

  ping(): Promise<void> {
    this.cluster.assertUp();
    return Promise.resolve();
  }

  acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    this.cluster.assertUp();
    const row = this.cluster.row({ tenantId, rootExecutionId });
    const now = this.cluster.clock();
    if (row.isRetired || isLive(row, now)) return Promise.resolve(undefined);
    const previous = row.lease;
    row.counter += 1;
    const taken: ExecutionLease = {
      tenantId,
      rootExecutionId,
      holderInstanceId: this.instanceId,
      token: row.counter,
      expiresAt: new Date(now.getTime() + duration),
      remaining: duration,
      ...takenOverFromOf(previous, !row.isReleased),
    };
    row.lease = taken;
    row.isReleased = false;
    return Promise.resolve(taken);
  }

  renew(lease: ExecutionLease, duration: Milliseconds): Promise<Milliseconds | undefined> {
    this.cluster.assertUp();
    const row = this.cluster.row(lease);
    const now = this.cluster.clock();
    if (!isSame(row, lease) || !isLive(row, now)) return Promise.resolve(undefined);
    row.lease = { ...lease, expiresAt: new Date(now.getTime() + duration) };
    return Promise.resolve(remainingOf(row.lease.expiresAt, now));
  }

  release(lease: ExecutionLease): Promise<void> {
    this.cluster.assertUp();
    const row = this.cluster.row(lease);
    if (isSame(row, lease)) row.isReleased = true;
    return Promise.resolve();
  }

  retire(lease: ExecutionLease): Promise<void> {
    this.cluster.assertUp();
    const row = this.cluster.row(lease);
    if (isSame(row, lease)) {
      row.isReleased = true;
      row.isRetired = true;
    }
    return Promise.resolve();
  }

  yield(lease: ExecutionLease): Promise<Milliseconds | undefined> {
    this.cluster.assertUp();
    const row = this.cluster.row(lease);
    const now = this.cluster.clock();
    return Promise.resolve(
      isSame(row, lease) && isLive(row, now) ? remainingOf(lease.expiresAt, now) : undefined,
    );
  }

  reclaim(lease: ExecutionLease, duration: Milliseconds): Promise<ExecutionLease | undefined> {
    this.cluster.assertUp();
    const row = this.cluster.row(lease);
    const now = this.cluster.clock();
    if (!isSame(row, lease) || !isLive(row, now)) return Promise.resolve(undefined);
    row.counter += 1;
    row.lease = {
      ...lease,
      token: row.counter,
      expiresAt: new Date(now.getTime() + duration),
      remaining: duration,
    };
    return Promise.resolve(row.lease);
  }

  raiseEpoch(tree: ExecutionTree, atLeast: number): Promise<void> {
    this.cluster.assertUp();
    const row = this.cluster.row(tree);
    row.counter = Math.max(row.counter, atLeast);
    return Promise.resolve();
  }

  publishMarks(tree: ExecutionTree, marks: TreeMarks): Promise<void> {
    this.cluster.assertUp();
    this.cluster.row(tree).marks = marks;
    return Promise.resolve();
  }
}
