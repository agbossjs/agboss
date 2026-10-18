import type { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../infrastructure/in-memory-database.js";
import { DEFAULT_TENANT_ID } from "../infrastructure/tenant.js";
import type { Timers } from "../infrastructure/timers.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { ExecutionLeaseLostError } from "./lease-lost.js";
import { leaseReleases } from "./lease-releases.js";

/**
 * Who moves an execution tree (#265, Q58): `app.execute` / `app.resume` hold the tree's lease
 * while they move it, renew it in the background every third of its length and right before
 * every checkpoint write, and release it when the pass ends (paused, finished or failed). A
 * paused or finished tree holds none. A renewal answered `false` (the lease expired and another
 * instance took it) aborts the holder's work with `ExecutionLeaseLostError`.
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
  /** Aborted with `ExecutionLeaseLostError` when another instance took the lease. */
  readonly signal: AbortSignal;
  /** Renews now (before a checkpoint write); throws `ExecutionLeaseLostError` when lost. */
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
  hold(rootExecutionId: string, signal?: AbortSignal): Promise<HeldExecutionLease>;
}

export function executionLeasesOf(
  repository: ExecutionLeaseRepository,
  timers: Timers,
): ExecutionLeases {
  const take = async (rootExecutionId: string): Promise<HeldExecutionLease | undefined> => {
    const lease = await repository.acquire(DEFAULT_TENANT_ID, rootExecutionId, EXECUTION_LEASE);
    if (lease === undefined) return undefined;
    const key = treeKeyOf(DEFAULT_TENANT_ID, rootExecutionId);
    const lost = new AbortController();
    const stopped = new AbortController();
    const renewNow = async (): Promise<void> => {
      lost.signal.throwIfAborted();
      if (await repository.renew(lease, EXECUTION_LEASE)) return;
      lost.abort(new ExecutionLeaseLostError(rootExecutionId));
      lost.signal.throwIfAborted();
    };
    void renewInBackground(timers, stopped.signal, renewNow);
    return {
      rootExecutionId,
      signal: lost.signal,
      renewNow,
      release: async () => {
        if (stopped.signal.aborted) return;
        stopped.abort();
        if (!lost.signal.aborted) await repository.release(lease);
        leaseReleases.notify(key);
      },
    };
  };
  return {
    hold: async (rootExecutionId, signal) => {
      const key = treeKeyOf(DEFAULT_TENANT_ID, rootExecutionId);
      for (;;) {
        signal?.throwIfAborted();
        const watch = leaseReleases.watch(key);
        try {
          const held = await take(rootExecutionId);
          if (held !== undefined) return held;
          await watch.wait((waiting) => timers.sleep(RETRY_EVERY, waiting), signal);
        } finally {
          watch.close();
        }
      }
    },
  };
}

/** Renews every third of the lease until stopped or lost; a store error is retried next time. */
async function renewInBackground(
  timers: Timers,
  stopped: AbortSignal,
  renewNow: () => Promise<void>,
): Promise<void> {
  for (;;) {
    await timers.sleep(RENEW_EVERY, stopped);
    if (stopped.aborted) return;
    try {
      await renewNow();
    } catch (error) {
      if (error instanceof ExecutionLeaseLostError) return;
    }
  }
}
