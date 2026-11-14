import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_FILE, manifestOf, manifestText } from "./manifest.js";
import type { SkillFile } from "./source.js";
import { TEMP_PREFIX } from "./status.js";

/**
 * Writes a project's skills folder at once (#305, #983): the new files, the project's own files
 * kept and the manifest go to `.agents/.agboss-skills-<random>/` — beside `skills/`, never in it,
 * because agents scan every child of `skills/` and a leftover there would be a second `agboss`
 * skill — which is then renamed into place: a crash leaves the old folder or the new one, never
 * half of each. A rename an antivirus or indexer holds (`EPERM` / `EBUSY`) is retried a few times.
 */

/** The calls a replace makes that a test may swap. */
export interface ReplaceOps {
  readonly rename: (from: string, to: string) => void;
  readonly rm: (path: string) => void;
  /** Blocks for `ms` between rename retries. */
  readonly wait: (ms: number) => void;
}

/** The file the project keeps: copied from `from` (absolute) to `path` inside the new folder. */
export interface KeptFile {
  readonly from: string;
  readonly path: string;
  /** `from` is a link of the project's: made again with the same text, never followed. */
  readonly isLink?: boolean;
}

/** Waits at most this many times, 50 ms doubling: 50 + 100 + 200 + 400 ms. */
const RENAME_RETRIES = 4;

/** The real file system; the wait blocks the thread (a CLI step, never a server's). */
export const REAL_REPLACE_OPS: ReplaceOps = {
  rename: renameSync,
  rm: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  wait: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

const isHeld = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EBUSY");

/** `rename`, retried while something holds the folder; the last error is thrown. */
export function renameRetrying(from: string, to: string, ops: ReplaceOps): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      ops.rename(from, to);
      return;
    } catch (error) {
      if (!isHeld(error) || attempt >= RENAME_RETRIES) throw error;
      ops.wait(50 * 2 ** attempt);
    }
  }
}

/** Writes `files` under `folder`, creating the folders they need. */
function writeAll(folder: string, files: readonly SkillFile[]): void {
  for (const file of files) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

/** Copies the project's own files into the new folder. */
function keepAll(to: string, kept: readonly KeptFile[]): void {
  for (const file of kept) {
    const target = join(to, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (file.isLink === true) symlinkSync(readlinkSync(file.from), target);
    else copyFileSync(file.from, target);
  }
}

/** Swaps the written folder in; the old one comes back when the swap fails. */
function swapIn(written: string, target: string, ops: ReplaceOps): void {
  if (!existsSync(target)) {
    renameRetrying(written, target, ops);
    return;
  }
  const old = `${written}-old`;
  renameRetrying(target, old, ops);
  try {
    renameRetrying(written, target, ops);
  } catch (error) {
    renameRetrying(old, target, ops);
    throw error;
  }
  ops.rm(old);
}

/** Replaces `target` (`<root>/.agents/skills/agboss`) with `files` of `version`, keeping `kept`. */
export function replaceSkillsFolder(
  target: string,
  files: readonly SkillFile[],
  version: string,
  kept: readonly KeptFile[],
  ops: ReplaceOps = REAL_REPLACE_OPS,
): void {
  const scratch = dirname(dirname(target));
  mkdirSync(dirname(target), { recursive: true });
  const written = join(scratch, `${TEMP_PREFIX}${randomBytes(4).toString("hex")}`);
  try {
    writeAll(written, files);
    keepAll(written, kept);
    writeFileSync(join(written, MANIFEST_FILE), manifestText(manifestOf(version, files)));
    swapIn(written, target, ops);
  } finally {
    ops.rm(written);
  }
}
