/**
 * Wakes the calls of this process waiting for a tree's lease when a holder in this process
 * releases it (#265, Q58), so they try again at once instead of at their next retry. A holder in
 * another process is noticed at the next retry (or when its lease expires). Only a hint: a woken
 * call still has to take the lease.
 */

/** The wait between two tries of a waiting call, ended early through its signal. */
export type RetryWait = (signal: AbortSignal) => Promise<void>;

/** A call's watch on one tree, opened before it tries the lease so no release is missed. */
export interface ReleaseWatch {
  /** Until `retry` ends, a release of the tree here, or `signal` aborts. */
  wait(retry: RetryWait, signal: AbortSignal | undefined): Promise<void>;
  close(): void;
}

const watchers = new Map<string, Set<AbortController>>();
const yielded = new Map<string, number>();

export const leaseReleases = {
  /** Wakes every call watching the tree `key`. */
  notify(key: string): void {
    watchers.get(key)?.forEach((watcher) => {
      watcher.abort();
    });
  },

  /** Marks `key` as yielded while its holder awaits remote children (#333 PR 4); returns how to unmark. */
  enterYielded(key: string): () => void {
    yielded.set(key, (yielded.get(key) ?? 0) + 1);
    return () => {
      const left = (yielded.get(key) ?? 1) - 1;
      if (left <= 0) yielded.delete(key);
      else yielded.set(key, left);
    };
  },

  /** Whether a live holder in this process has yielded `key` while awaiting remote children. */
  isYielded(key: string): boolean {
    return yielded.has(key);
  },

  watch(key: string): ReleaseWatch {
    const woken = new AbortController();
    const forKey = watchers.get(key) ?? new Set<AbortController>();
    forKey.add(woken);
    watchers.set(key, forKey);
    return {
      wait: async (retry, signal) => {
        const end = AbortSignal.any(signal === undefined ? [woken.signal] : [woken.signal, signal]);
        await retry(end);
      },
      close: () => {
        forKey.delete(woken);
        if (forKey.size === 0 && watchers.get(key) === forKey) watchers.delete(key);
      },
    };
  },
};
