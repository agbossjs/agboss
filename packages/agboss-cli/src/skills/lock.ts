import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TEMP_PREFIX } from "./status.js";
import {
  clearEmpty,
  dropOwner,
  isAlive,
  isStale,
  observedFutureMs,
  newOwner,
  OWNER_PREFIX,
  readHolder,
  sweepStray,
  type Holder,
  type LockOwner,
} from "./lock-owner.js";

/**
 * The lock that serialises the skills syncs of one project (#983 D3, #1013): a `dev` pass beside
 * `npm install` run the same sync, and two of them swapping the folder at once make the loser fail
 * on a state that ends up correct. The lock is `.agents/.agboss-skills-lock/` holding the owner's
 * file (`lock-owner.ts`). It is made complete beside it and renamed into place: a rename onto a
 * folder that has an owner fails, so exactly one waiter wins and a lock is never without its
 * owner. Its name starts with the temporary folders' prefix, so `.gitignore`'s
 * `.agents/.agboss-skills-*` covers it.
 *
 * A live holder keeps its lock however long it takes; only a dead one (its pid is gone on this
 * host) is taken over, at once. A lock from another host, or with an unreadable owner, ages out
 * after `staleMs`, counted from when this waiter first saw it if its time lies a minute or more in
 * the future (#1105). A holder releases only a lock that is still its own, and Ctrl-C releases it.
 */

/** The lock folder's name, in `.agents/`. */
export const LOCK_NAME = `${TEMP_PREFIX}lock`;

/** How long a waiting sync tries, and how old a lock of an unknown owner must be to be stale. */
export interface LockOptions {
  readonly waitMs: number;
  readonly staleMs: number;
}

export const DEFAULT_LOCK: LockOptions = { waitMs: 12_000, staleMs: 10 * 60_000 };

const POLL_MS = 25;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** The errors of a rename onto a folder that is someone's (POSIX and Windows spell it differently). */
const HELD = new Set(["ENOTEMPTY", "EEXIST", "EPERM"]);

/** Makes the lock with `owner`; false when someone holds it. Other errors are thrown. */
function tryMake(agents: string, lock: string, owner: LockOwner): boolean {
  const fresh = join(agents, `${LOCK_NAME}-new-${randomBytes(4).toString("hex")}`);
  mkdirSync(fresh);
  try {
    writeFileSync(join(fresh, `${OWNER_PREFIX}${owner.token}`), JSON.stringify(owner));
    renameSync(fresh, lock);
    return true;
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    if (error instanceof Error && "code" in error && HELD.has(String(error.code))) return false;
    throw error;
  }
}

/**
 * Takes a dead holder's lock away (at most one waiter's `unlink` wins); a live one is left. The
 * winner also sweeps what else the folder holds (a `.DS_Store`, a 0.1.0 `owner`): the holder just
 * proved abandoned, and dropping its file refreshed the folder's mtime, so judging the rest by age
 * would wait `staleMs` again (#1106). While any entry stands no new lock can be renamed in, and a
 * sweep never removes an `owner-` file, so a lock made meanwhile is safe.
 */
function clearIfStale(lock: string, staleMs: number): void {
  const seen = readHolder(lock);
  if (seen === undefined) return;
  const holder = withObserved(lock, seen);
  if (holder.token === undefined) {
    clearEmpty(lock);
    if (holder.ageMs > staleMs) sweepStray(lock);
  } else if (isStale(holder, staleMs) && dropOwner(lock, holder.token)) sweepStray(lock);
}

/**
 * A lock whose time is in the future is not stale at once and does not wait for that time (#1105):
 * its age is how long this waiter has watched it. A live holder of this host is never judged by
 * time (its pid is), and a dead one is taken over at once by `isStale`; only a lock of another
 * host, an owner nobody can read or a folder with no owner ages out this way.
 */
function withObserved(lock: string, holder: Holder): Holder {
  if (!holder.isFuture) return holder;
  if (holder.owner?.host === hostname() && isAlive(holder.owner.pid)) return holder;
  return { ...holder, ageMs: Math.max(holder.ageMs, observedFutureMs(lock, holder.token)) };
}

/** The `-new-` folders of a crash between the lock's `mkdir` and its rename, once they are stale. */
function sweepCrashed(agents: string, staleMs: number): void {
  for (const name of readdirSync(agents)) {
    if (!name.startsWith(`${LOCK_NAME}-new-`)) continue;
    const path = join(agents, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // gone meanwhile: nothing to sweep
    }
  }
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Listeners for Ctrl-C while the lock is held. The sync is synchronous, so a signal is handled
 * after it: the lock is released by then, and the process dies of the signal as it would have. The
 * listeners stay for two ticks, so a signal that came in during the work still finds them.
 */
function guardSignals(): () => void {
  const hooks = SIGNALS.map((signal) => {
    const hook = (): void => {
      for (const [name, one] of hooks) process.removeListener(name, one);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, hook);
    return [signal, hook] as const;
  });
  return () => {
    setImmediate(() => {
      setImmediate(() => {
        for (const [name, hook] of hooks) process.removeListener(name, hook);
      });
    });
  };
}

/**
 * Runs `work` holding the project's sync lock; undefined when the lock stayed with a live holder
 * for `waitMs`. `.agents/` is made when it is not there.
 */
export function withSyncLock<T>(
  root: string,
  work: () => T,
  options: LockOptions = DEFAULT_LOCK,
): { readonly value: T } | undefined {
  const agents = join(root, ".agents");
  mkdirSync(agents, { recursive: true });
  const lock = join(agents, LOCK_NAME);
  const owner = newOwner();
  const until = Date.now() + options.waitMs;
  while (!tryMake(agents, lock, owner)) {
    clearIfStale(lock, options.staleMs);
    if (Date.now() >= until) return undefined;
    sleep(POLL_MS);
  }
  const unguard = guardSignals();
  try {
    sweepCrashed(agents, options.staleMs);
    return { value: work() };
  } finally {
    dropOwner(lock, owner.token);
    unguard();
  }
}
