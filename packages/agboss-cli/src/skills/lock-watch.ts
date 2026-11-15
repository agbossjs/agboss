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
import { ageOf, isRegular, SEEN_MARKER, unlinkEntry, writeBeside } from "./lock-files.js";
import { OWNER_PREFIX } from "./lock-owner.js";

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
 * How long a lock whose age on disk cannot be trusted has been watched, unchanged (#1105): a time
 * in the future, or a live pid whose recorded start does not fit (a clock stepped, or a reused pid).
 * The age counts from the first sight, never from the file: this process's monotonic clock, and a
 * marker file in the folder (its mtime is this host's own clock at the first sight, its text the
 * owner file's mtime then), so a run per `agboss check` still sees the lock age across processes.
 * The longer of the two counts. A holder that refreshes its owner file (`renewOwner`) changes the
 * fingerprint and starts the count over, in this process and in the marker; a marker dated ahead
 * (the clock stepped back again) counts as nothing.
 */
/**
 * How old the marker is when it holds `print`; a marker of another print (the holder refreshed), a
 * link or a folder in its place is replaced by a new one (made beside it and renamed over it, never
 * written through) and counts as nothing.
 */
function markerAge(marker: string, print: string): number {
  try {
    const seen = lstatSync(marker, { throwIfNoEntry: false });
    if (seen?.isFile() === true && readFileSync(marker, "utf8") === print)
      return Math.max(0, ageOf(marker) ?? 0);
    if (seen !== undefined && !seen.isFile()) unlinkEntry(marker);
    writeBeside(marker, print);
  } catch {
    // another waiter's write, or the lock is gone: the next poll reads it
  }
  return 0;
}

export function observedMs(lock: string, token: string | undefined): number {
  const print = fingerprintOf(lock, token);
  const key = `${lock}|${token ?? ""}`;
  const now = performance.now();
  const before = firstSeen.get(key);
  const first = before?.print === print ? before.first : now;
  firstSeen.set(key, { first, print });
  const onDisk = markerAge(join(lock, SEEN_MARKER), print);
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
