import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TEMP_PREFIX } from "./status.js";

/**
 * The lock that serialises the skills syncs of one project (#983 D3): a `dev` pass beside
 * `npm install` run the same sync, and two of them swapping the folder at once make the loser fail
 * on a state that ends up correct. `mkdir` is atomic on every platform: the one that makes
 * `.agents/.agboss-skills-lock` writes; the others wait a short while. Its name starts with the
 * temporary folders' prefix, so `.gitignore`'s `.agents/.agboss-skills-*` covers it. A lock whose
 * holder was killed is stale after a few seconds and taken over.
 */

/** The lock folder's name, in `.agents/`. */
export const LOCK_NAME = `${TEMP_PREFIX}lock`;

/** How long a waiting sync tries, and how old a lock must be to be a dead holder's. */
export interface LockOptions {
  readonly waitMs: number;
  readonly staleMs: number;
}

export const DEFAULT_LOCK: LockOptions = { waitMs: 12_000, staleMs: 10_000 };

const POLL_MS = 25;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/** Makes the lock; false when someone holds it. Other errors (no folder, no rights) are thrown. */
function tryMake(lock: string): boolean {
  try {
    mkdirSync(lock);
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  writeFileSync(join(lock, "owner"), `${String(process.pid)} ${new Date().toISOString()}\n`);
  return true;
}

/** Takes a dead holder's lock away: one rename wins, so two waiters never remove a fresh lock. */
function breakIfStale(lock: string, staleMs: number): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= staleMs) return;
    const taken = `${lock}-stale-${randomBytes(4).toString("hex")}`;
    renameSync(lock, taken);
    rmSync(taken, { recursive: true, force: true });
  } catch (error) {
    // the holder released it, or another waiter took it first: both are fine
    if (!isCode(error, "ENOENT")) throw error;
  }
}

/**
 * Runs `work` holding the project's sync lock; undefined when the lock stayed with someone else
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
  const until = Date.now() + options.waitMs;
  while (!tryMake(lock)) {
    breakIfStale(lock, options.staleMs);
    if (Date.now() >= until) return undefined;
    sleep(POLL_MS);
  }
  try {
    return { value: work() };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
