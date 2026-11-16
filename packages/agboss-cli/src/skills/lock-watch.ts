import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRegular, SEEN_MARKER, unlinkEntry, writeBeside } from "./lock-files.js";
import { OWNER_PREFIX, SKEW_MS } from "./lock-owner.js";
import { realClock, type LockClock } from "./lock-clock.js";

/** What a holder's refresh changes: the owner file's mtime (none: the folder holds no owner file). */
export function fingerprintOf(lock: string, token: string | undefined): string {
  try {
    return token === undefined
      ? "none"
      : String(lstatSync(join(lock, `${OWNER_PREFIX}${token}`)).mtimeMs);
  } catch {
    return "none";
  }
}

/** This waiter's own first sight of a lock, on the monotonic clock (immune to a stepped wall clock). */
const firstSeen = new Map<string, { readonly first: number; readonly print: string }>();

/**
 * How old the marker is, on a clock that cannot be stepped. It holds `print` (what the holder's
 * refresh changes) and the monotonic time it was written at (one for every process of this host);
 * its mtime is the wall time then. The age is the shorter of the two counts: a wall clock set
 * forward cannot age the lock, a wall clock set back (the mtime lies ahead by more than the skew)
 * or a reboot (the monotonic time lies ahead of now) cannot freeze it. A marker that is not
 * trustworthy by that, of another print (the holder refreshed), a link or a folder in its place, is
 * replaced by a new one dated now (made beside it and renamed over it, never written through)
 * and counts as nothing: the lock then ages out `staleMs` of real time after.
 */
function markerAge(marker: string, print: string, clock: LockClock): number {
  try {
    const seen = lstatSync(marker, { throwIfNoEntry: false });
    if (seen?.isFile() === true) {
      const [text, written] = readFileSync(marker, "utf8").split("\n");
      const wallAge = clock.wall() - seen.mtimeMs;
      const monoAge = written === undefined ? NaN : clock.mono() - Number(written);
      if (text === print && wallAge >= -SKEW_MS && monoAge >= 0)
        return Math.max(0, Math.min(wallAge, monoAge));
    } else if (seen !== undefined) unlinkEntry(marker);
    writeBeside(marker, `${print}\n${String(clock.mono())}`, clock.wall());
  } catch {
    // another waiter's write, or the lock is gone: the next poll reads it
  }
  return 0;
}

/**
 * How long a lock whose age on disk cannot be trusted has been watched, unchanged (#1105): a time
 * in the future, or a live pid whose recorded start does not fit (a clock stepped, or a reused pid).
 * The age counts from the first sight, never from the file: this process's monotonic clock, and a
 * marker file in the folder (its mtime is this host's own clock at the first sight, its text the
 * owner file's mtime then), so a run per `agboss check` still sees the lock age across processes.
 * The longer of the two counts. A holder that refreshes its owner file (`renewOwner`) changes the
 * fingerprint and starts the count over, in this process and in the marker.
 */
export function observedMs(
  lock: string,
  token: string | undefined,
  clock: LockClock = realClock,
): number {
  const print = fingerprintOf(lock, token);
  const key = `${lock}|${token ?? ""}`;
  const now = clock.mono();
  const before = firstSeen.get(key);
  const first = before?.print === print ? before.first : now;
  firstSeen.set(key, { first, print });
  const onDisk = markerAge(join(lock, SEEN_MARKER), print, clock);
  return Math.max(now - first, onDisk);
}

/** The holder shows it is alive: its owner file's time is now (a long sync calls this between steps). */
export function renewOwner(lock: string, token: string): void {
  const file = join(lock, `${OWNER_PREFIX}${token}`);
  try {
    if (!isRegular(file)) {
      unlinkEntry(file);
      return;
    }
    // O_NOFOLLOW: a link put in place after the check is refused, not touched through
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).isFile()) futimesSync(fd, new Date(), new Date());
    } finally {
      closeSync(fd);
    }
  } catch {
    // the lock was taken from under us, or the entry is a link: the release finds that out
    unlinkEntryIfLink(file);
  }
}

/** A link that appeared where the owner file was is removed itself, never followed. */
function unlinkEntryIfLink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkEntry(path);
}

/** Ends this process's own watches (a test calls it between the checks of one simulated process each). */
export function forgetObserved(): void {
  firstSeen.clear();
}
