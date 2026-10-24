/**
 * Hints between the instances of this process (#333 PR 2), like `lease-releases.ts`: a queued child
 * wakes the claimers at once, an ended child wakes the parent waiting for it. Instances in other
 * processes notice at their next look (a claimer at its sweep, a parent every second). Only hints:
 * a woken claimer still has to claim the row, a woken parent still reads it.
 */

const claimers = new Set<() => void>();
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

  /** A child was queued: every claimer of this process looks now. */
  queued(): void {
    for (const claim of [...claimers]) claim();
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

  /** The child `key` ended: its parent in this process reads its row now. */
  ended(key: string): void {
    waiting.get(key)?.forEach((watcher) => {
      watcher.abort();
    });
  },
};
