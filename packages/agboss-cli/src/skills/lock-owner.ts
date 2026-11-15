import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { ageOf, isRegular, SEEN_MARKER, unlinkEntry } from "./lock-files.js";
import { z } from "zod";

/**
 * Who holds the sync lock (#1013). The lock folder holds one file `owner-<token>`: the holder's
 * pid, host, process start time and a random token. A waiter reads it to tell a dead holder from a
 * live one; the token names exactly one lock, so a take-over or a release can never touch another
 * holder's lock — `unlink` of `owner-<token>` fails when that lock is already gone or replaced.
 */

/** The owner file's name prefix, in the lock folder. */
export const OWNER_PREFIX = "owner-";

const OwnerSchema = z.object({
  token: z.string().min(1),
  pid: z.number().int().positive(),
  host: z.string(),
  procStart: z.number(),
  startedAt: z.string(),
});

/** What the owner file says. */
export type LockOwner = z.infer<typeof OwnerSchema>;

/** A new owner: this process, now. */
export const newOwner = (): LockOwner => ({
  token: randomBytes(8).toString("hex"),
  pid: process.pid,
  host: hostname(),
  procStart: Math.round(Date.now() - process.uptime() * 1000),
  startedAt: new Date().toISOString(),
});

/** What a waiter sees in the lock folder. */
export interface Holder {
  /** The token in the file name; undefined for a folder with no owner file. */
  readonly token: string | undefined;
  /** The parsed file; undefined when it is unreadable. */
  readonly owner: LockOwner | undefined;
  readonly ageMs: number;
  /**
   * A time on disk lies more than `SKEW_MS` ahead of this clock: the clock was set back, or the
   * folder came from a host that runs ahead (#1105). `ageMs` is then "just now" (0), never
   * negative and never infinite: the age is not trusted either way, see `observedFutureMs`.
   */
  readonly isFuture?: boolean;
  /** A live pid on this host whose recorded start does not fit: not known to be gone (see `isStale`). */
  readonly isUnknown?: boolean;
  /** The owner entry is not a regular file (a link): unknown, and removed itself by the waiter. */
  readonly isLinked?: boolean;
}

/** The pid is a live process on this host (`EPERM`: alive, not ours to signal). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Seconds from `ps -o etime=` (`[[dd-]hh:]mm:ss`); undefined when it cannot be read. */
function elapsedSeconds(pid: number): number | undefined {
  const run = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(run.stdout);
  if (run.status !== 0 || match === null) return undefined;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part) || 0);
  return ((days ?? 0) * 24 + (hours ?? 0)) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

/** A live pid that started long after the lock was made belongs to another process (pid reuse). */
export function isReused(owner: LockOwner): boolean {
  const elapsed = elapsedSeconds(owner.pid);
  return elapsed !== undefined && Math.abs(Date.now() - elapsed * 1000 - owner.procStart) > 5000;
}

/** How far ahead of this clock a time on disk may lie before it is not a clock skew any more. */
export const SKEW_MS = 60_000;

/**
 * The lock folder's owner; undefined when there is no folder. What cannot be read is judged by its
 * age on disk (the older of the file's and the folder's mtime), never as "just now": an empty or
 * garbage owner file, or a folder with no owner file, must age out (#1075).
 */
export function readHolder(lock: string): Holder | undefined {
  let names: string[];
  try {
    names = readdirSync(lock);
  } catch {
    return undefined;
  }
  const name = names.find((entry) => entry.startsWith(OWNER_PREFIX));
  const folderAge = ageOf(lock) ?? 0;
  const file = name === undefined ? undefined : join(lock, name);
  const ages = file === undefined ? [folderAge] : [folderAge, ageOf(file) ?? 0];
  const isFuture = ages.some((age) => age < -SKEW_MS);
  const ageMs = Math.max(0, ...ages);
  if (file === undefined || name === undefined)
    return { token: undefined, owner: undefined, ageMs, isFuture };
  const token = name.slice(OWNER_PREFIX.length);
  // a link or a folder is not an owner file and is not read through
  if (!isRegular(file)) return { token, owner: undefined, ageMs, isFuture, isLinked: true };
  return { token, owner: readOwner(file), ageMs, isFuture };
}

/** The owner file's content; undefined when it is not what an owner file holds. */
function readOwner(file: string): LockOwner | undefined {
  try {
    const parsed = OwnerSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Waiting this long on a pid that "lives" before asking `ps` whether it is the same process. */
export const REUSE_CHECK_MS = 30_000;

/**
 * The holder is gone: its pid is dead on this host (the only instant verdict), or — another host,
 * an owner file nobody can read — the lock is older than `staleMs`, the last resort. A live pid
 * whose start time does not fit (`isUnknown`: reused, or a stepped clock) is not known to be gone:
 * it is taken only once it was watched unchanged for `staleMs` (`ageMs` is then that watch).
 * A live owner whose start fits never is.
 */
export function isStale(holder: Holder, staleMs: number): boolean {
  const { owner } = holder;
  if (owner?.host !== hostname()) return holder.ageMs > staleMs;
  if (!isAlive(owner.pid)) return true;
  return holder.isUnknown === true && holder.ageMs > staleMs;
}

/**
 * Removes the lock `token` names, if it is still there: the owner file goes (exactly one caller's
 * `unlink` succeeds; another holder's lock has another token), then the folder, which `rmdir`
 * leaves alone when someone has already made it again. True when this call removed the file.
 */
export function dropOwner(lock: string, token: string): boolean {
  try {
    unlinkSync(join(lock, `${OWNER_PREFIX}${token}`));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  unlinkEntry(join(lock, SEEN_MARKER));
  clearEmpty(lock);
  return true;
}

/** Removes the lock folder when it is empty; any other state is someone's and stays. */
export function clearEmpty(lock: string): void {
  try {
    rmdirSync(lock);
  } catch {
    // not empty (a new holder), not there, or held by the system: not ours to remove
  }
}

/**
 * Clears a lock folder that has no owner file but something else in it (the pre-#1013 format, a
 * stray file): its entries go by name, then the folder through `clearEmpty`. A fresh lock made
 * meanwhile holds an `owner-` file, which is never swept, so it keeps the folder.
 */
export function sweepStray(lock: string): void {
  let names: string[];
  try {
    names = readdirSync(lock);
  } catch {
    return;
  }
  for (const name of names)
    if (!name.startsWith(OWNER_PREFIX)) rmSync(join(lock, name), { recursive: true, force: true });
  clearEmpty(lock);
}
