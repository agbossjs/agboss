import type { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import { waitOf } from "../infrastructure/clock-timeout.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { ExecutionLeaseLostError, leaseExpiredError } from "./lease-lost.js";
import { leaseReleases } from "./lease-releases.js";

/**
 * Who moves an execution tree (#265, Q58): `app.execute` / `app.resume` hold the tree's lease
 * while they move it, renew it in the background every third of its length and right before
 * every checkpoint write, and release it when the pass ends (paused, finished or failed). A
 * paused or finished tree holds none. A renewal answered `false` (the lease expired and another
 * instance took it) aborts the holder's work with `ExecutionLeaseLostError`.
 *
 * Local fencing (#335 S1): the holder knows its lease is valid until `confirmedUntil` — the `Clock`
 * read before the last acquire or renewal the store confirmed, plus the lease's length (the store
 * counts from a later moment, so its lease never ends earlier). A store error before then is
 * retried and lets a checkpoint write go on; at `confirmedUntil` with no confirmed renewal the
 * holder stops at once — its signal aborts with `ExecutionLeaseLostError` (the tool loop starts no
 * further call) and a write at or past it throws it.
 */

/** The length of a tree's lease — fixed, not a setting (Q58). */
const EXECUTION_LEASE: Milliseconds = seconds(30);

/** A third of the lease: two renewals may fail before it expires. */
const RENEW_EVERY: Milliseconds = seconds(10);

/** How often a call waiting for a tree held elsewhere tries again (a release here wakes it at once). */
const RETRY_EVERY: Milliseconds = seconds(1);

/** A tree's lease while this instance moves the tree. */
export interface HeldExecutionLease {
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
  /** Stops renewing and gives the lease up (nothing to give when it was lost). */
  release(): Promise<void>;
}

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
  const { tenantId, rootExecutionId } = tree;
  const askedAt = clock.now().getTime();
  const lease = await repository.acquire(tenantId, rootExecutionId, EXECUTION_LEASE);
  if (lease === undefined) return undefined;
  const lost = new AbortController();
  const stopped = new AbortController();
  const fence = new LeaseFence(clock, askedAt, lost, rootExecutionId);
  const renewNow = async (): Promise<void> => {
    lost.signal.throwIfAborted();
    const renewedAt = clock.now().getTime();
    const isRenewed = await repository
      .renew(lease, EXECUTION_LEASE)
      .catch((): undefined => undefined);
    fence.settle(renewedAt, isRenewed);
  };
  const working = AbortSignal.any([stopped.signal, lost.signal]);
  void renewInBackground(clock, working, renewNow);
  void expireInBackground(clock, working, fence);
  return {
    rootExecutionId,
    signal: lost.signal,
    renewNow,
    release: async () => {
      if (stopped.signal.aborted) return;
      stopped.abort();
      if (!lost.signal.aborted) await repository.release(lease);
      leaseReleases.notify(treeKeyOf(tenantId, rootExecutionId));
    },
  };
}

/**
 * How long the holder may trust its lease (#335 S1): until `confirmedUntil`, the `Clock` read
 * before the last acquire or renewal its store confirmed plus the lease's length.
 */
class LeaseFence {
  #confirmedUntil: number;

  constructor(
    private readonly clock: Clock,
    askedAt: number,
    private readonly lost: AbortController,
    private readonly rootExecutionId: string,
  ) {
    this.#confirmedUntil = askedAt + EXECUTION_LEASE;
  }

  /** The time (ms) up to which the lease is valid here. */
  get confirmedUntil(): number {
    return this.#confirmedUntil;
  }

  /** Aborts the holder: the lease ran out with no renewal the store confirmed. */
  expire(): void {
    if (!this.lost.signal.aborted) this.lost.abort(leaseExpiredError(this.rootExecutionId));
  }

  /**
   * A renewal asked at `renewedAt` answered: `true` moves the fence on, `false` (taken) aborts,
   * `undefined` (the store did not answer) aborts only once the lease ran out here — before that
   * the caller's write goes on. Throws the holder's `ExecutionLeaseLostError` once aborted.
   */
  settle(renewedAt: number, isRenewed: boolean | undefined): void {
    this.lost.signal.throwIfAborted();
    if (isRenewed === true) {
      this.#confirmedUntil = Math.max(this.#confirmedUntil, renewedAt + EXECUTION_LEASE);
      return;
    }
    if (isRenewed === false) this.lost.abort(new ExecutionLeaseLostError(this.rootExecutionId));
    else if (this.clock.now().getTime() >= this.#confirmedUntil) this.expire();
    this.lost.signal.throwIfAborted();
  }
}

/**
 * Renews every third of the lease until stopped or lost; a store error is retried next time (the
 * expiry below stops the holder when none succeeds in time).
 */
async function renewInBackground(
  clock: Clock,
  working: AbortSignal,
  renewNow: () => Promise<void>,
): Promise<void> {
  for (;;) {
    await clock.sleep(RENEW_EVERY, working);
    if (working.aborted) return;
    try {
      await renewNow();
    } catch (error) {
      if (error instanceof ExecutionLeaseLostError) return;
    }
  }
}

/**
 * Sleeps until the lease runs out here (`confirmedUntil`, moved on by every confirmed renewal) and
 * then expires it (#335): the holder stops at the lease's end even while its store does not answer.
 */
async function expireInBackground(
  clock: Clock,
  working: AbortSignal,
  fence: LeaseFence,
): Promise<void> {
  for (;;) {
    const left = fence.confirmedUntil - clock.now().getTime();
    if (left <= 0) {
      fence.expire();
      return;
    }
    await clock.sleep(waitOf(left), working);
    if (working.aborted) return;
  }
}
