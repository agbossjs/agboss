import { randomBytes } from "node:crypto";
import {
  closeSync,
  futimesSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** What a waiter leaves in a lock folder it cannot judge by time: its mtime is when it first saw the lock as it is. */
export const SEEN_MARKER = "seen-future";

/**
 * How long ago `path` was last written, signed (negative: the time lies ahead); undefined when it
 * cannot be stat'ed. What to make of a time far ahead is the caller's (`readHolder`, `observed`).
 */
export function ageOf(path: string, now: number = Date.now()): number | undefined {
  try {
    return now - lstatSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Everything written, touched or read in the lock folder goes through `lstat`: a cloned project can
 * ship the folder with an entry that is a link to a file outside it (`~/.bashrc`), and a write
 * through it would change that file. A non-regular entry is never followed; it is removed itself.
 */
export const isRegular = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** Removes the entry itself (a link is not followed, a folder is not entered); false when it stays. */
export function unlinkEntry(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined;
  }
}

/**
 * Writes `text` to `path` as a new file made `wx` beside it and renamed over it: what is at `path`
 * (a link to somewhere else included) is replaced, never written through. `at` is the file's
 * mtime (this clock's now), set on the new file before it is renamed into place.
 */
export function writeBeside(path: string, text: string, at: number = Date.now()): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx");
    try {
      writeSync(fd, text);
      futimesSync(fd, new Date(at), new Date(at));
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
