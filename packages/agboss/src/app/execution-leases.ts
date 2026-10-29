import type { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { FrameLease } from "../flow/context/frame.js";
import { HeldLease } from "./held-lease.js";
import { EXECUTION_LEASE } from "./lease-fence.js";
import { leaseReleases } from "./lease-releases.js";

/**
 * Who moves an execution tree (#265, Q58): `app.execute` / `app.resume` hold the tree's lease
 * while they move it, renew it in the background every third of its length and right before
 * every checkpoint write, and release it when the pass ends (paused, finished or failed). While a
 * parent node awaits remote children in-step (#333 PR 4, S9 Q1), it yields the lease in
 * `ExecutionLeaseRepository` and re-acquires it before continuing.
 */

/** How often a call waiting for a tree held elsewhere tries again (a release here wakes it at once). */
const RETRY_EVERY: Milliseconds = seconds(1);

/** A tree's lease while this instance moves the tree. */
export interface HeldExecutionLease extends FrameLease {
  readonly rootExecutionId: string;
  /**
   * Aborted with `ExecutionLeaseLostError` when another instance took the lease, or when it ran
   * out with no renewal the store confirmed.
   */
  readonly signal: AbortSignal;
  /**
   * Renews now (before a checkpoint write); throws `ExecutionLeaseLostError` when lost. A store
   * error while the lease is still valid here resolves (the next renewal tries again).
   */
  renewNow(): Promise<void>;
  /**
   * Runs `check` after every renewal the store confirmed — the background one, the one before a
   * checkpoint write and `confirmNow()` (#360: the holder looks for a cancel request); `check` never
   * throws.
   */
  afterEachRenewal(check: RenewalCheck): void;
  /**
   * Yields the lease in `ExecutionLeaseRepository` while `wait` awaits remote children (#333 PR 4,
   * S9 Q1) — only while no other step of the tree runs (#471) — and re-acquires it before
   * returning so `.join()` and checkpoint writes run under it.
   */
  yieldWhile<T>(wait: () => Promise<T>): Promise<T>;
  /** Stops renewing and gives the lease up (nothing to give when it was lost). */
  release(): Promise<void>;
}

/** What the holder does after a confirmed renewal of its lease (#360). */
export type RenewalCheck = () => Promise<void>;

/** The leases of one application instance's trees. */
export interface ExecutionLeases {
  /**
   * The tree's lease: at once when free, else once its holder releases it or its lease expires;
   * `signal` (the caller's) ends the wait with its reason.
   */
  hold(tree: ExecutionTree, signal?: AbortSignal): Promise<HeldExecutionLease>;
  /** The tree's lease when it is free now (recovery, #265 S30); `undefined` while another holds it. */
  tryHold(tree: ExecutionTree): Promise<HeldExecutionLease | undefined>;
}

export function executionLeasesOf(
  repository: ExecutionLeaseRepository,
  clock: Clock,
): ExecutionLeases {
  const take = (tree: ExecutionTree): Promise<HeldExecutionLease | undefined> =>
    takeLease(repository, clock, tree);
  return {
    tryHold: take,
    hold: async (tree, signal) => {
      const key = treeKeyOf(tree.tenantId, tree.rootExecutionId);
      for (;;) {
        signal?.throwIfAborted();
        const watch = leaseReleases.watch(key);
        try {
          const held = await take(tree);
          if (held !== undefined) return held;
          await watch.wait((waiting) => clock.sleep(RETRY_EVERY, waiting), signal);
        } finally {
          watch.close();
        }
      }
    },
  };
}

/** The tree's lease when the store gives it, renewed and watched in the background until released. */
async function takeLease(
  repository: ExecutionLeaseRepository,
  clock: Clock,
  tree: ExecutionTree,
): Promise<HeldExecutionLease | undefined> {
  const askedAt = clock.now().getTime();
  const initial = await repository.acquire(tree.tenantId, tree.rootExecutionId, EXECUTION_LEASE);
  return initial === undefined
    ? undefined
    : new HeldLease(repository, clock, tree, initial, askedAt);
}
