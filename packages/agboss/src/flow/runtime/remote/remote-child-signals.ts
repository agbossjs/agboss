import type { QueuedChildExecution } from "../../../infrastructure/child-execution-queue.repository.js";

/**
 * Hints between the instances of this process (#333 PR 2, PR 4), like `lease-releases.ts`: a queued
 * child wakes the claimers at once, a `Running` child seen by a waiting parent lets a live worker
 * reclaim it once its lease in `ExecutionLeaseRepository` is free, and an ended or paused child
 * wakes the parent waiting for it. Only hints: a woken claimer still has to claim the row, a
 * reclaimer still has to take the child's lease, a woken parent still reads the row.
 */

const claimers = new Set<() => void>();
const reclaimers = new Set<(row: QueuedChildExecution) => void>();
const claiming = new Set<string>();
const waiting = new Map<string, Set<AbortController>>();

/** A parent's watch on one child, opened before it reads the row so no end is missed. */
export interface ChildEndWatch {
  /** Aborted when the child ends in this process. */
  readonly signal: AbortSignal;
  close(): void;
}

export const remoteChildSignals = {
  /** Calls `claim` whenever a child is queued in this process; returns how to stop. */
  onQueued(claim: () => void): () => void {
    claimers.add(claim);
    return () => {
      claimers.delete(claim);
    };
  },

  /** A child was queued: every claimer of this process (except `exclude`, if given) looks now. */
  queued(exclude?: () => void): void {
    for (const claim of [...claimers]) if (claim !== exclude) claim();
  },

  /** Calls `reclaim` when a waiting parent sees a `Running` child row (#333 PR 4). */
  onRunning(reclaim: (row: QueuedChildExecution) => void): () => void {
    reclaimers.add(reclaim);
    return () => {
      reclaimers.delete(reclaim);
    };
  },

  /** A waiting parent saw `row` `Running`: a live worker reclaims it if its lease is free. */
  running(row: QueuedChildExecution): void {
    for (const reclaim of [...reclaimers]) reclaim(row);
  },

  /** Marks `key` while its claimer acquires its initial lease; returns how to unmark. */
  enterClaim(key: string): () => void {
    claiming.add(key);
    return () => {
      claiming.delete(key);
    };
  },

  /** Whether a claimer in this process is acquiring `key`'s initial lease right now. */
  isClaiming(key: string): boolean {
    return claiming.has(key);
  },

  watchEnd(key: string): ChildEndWatch {
    const woken = new AbortController();
    const forKey = waiting.get(key) ?? new Set<AbortController>();
    forKey.add(woken);
    waiting.set(key, forKey);
    return {
      signal: woken.signal,
      close: () => {
        forKey.delete(woken);
        if (forKey.size === 0 && waiting.get(key) === forKey) waiting.delete(key);
      },
    };
  },

  /** The child `key` ended (or paused / released its lease): its parent reads its row now. */
  ended(key: string): void {
    waiting.get(key)?.forEach((watcher) => {
      watcher.abort();
    });
  },
};
