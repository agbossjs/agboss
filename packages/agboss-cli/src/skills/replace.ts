import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_FILE, manifestOf, manifestText } from "./manifest.js";
import type { SkillFile } from "./source.js";

/**
 * Writes a project's skills folder at once (#305): the new files, the project's own files kept and
 * the manifest go to `.claude/skills/.agboss-skills-<random>/`, which is then renamed into place —
 * a crash leaves the old folder or the new one, never half of each.
 */

/** Writes `files` under `folder`, creating the folders they need. */
function writeAll(folder: string, files: readonly SkillFile[]): void {
  for (const file of files) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

/** Copies the project's own files from the old folder into the new one. */
function keepAll(from: string, to: string, paths: readonly string[]): void {
  for (const path of paths) {
    const target = join(to, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, path), target);
  }
}

/** Swaps the written folder in; the old one comes back when the swap fails. */
function swapIn(written: string, target: string): void {
  if (!existsSync(target)) {
    renameSync(written, target);
    return;
  }
  const old = `${written}-old`;
  renameSync(target, old);
  try {
    renameSync(written, target);
  } catch (error) {
    renameSync(old, target);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}

/** Replaces `target` with `files` of `version`, keeping the project's own files (`kept`). */
export function replaceSkillsFolder(
  target: string,
  files: readonly SkillFile[],
  version: string,
  kept: readonly string[],
): void {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const written = join(parent, `.agboss-skills-${randomBytes(4).toString("hex")}`);
  try {
    writeAll(written, files);
    keepAll(target, written, kept);
    writeFileSync(join(written, MANIFEST_FILE), manifestText(manifestOf(version, files)));
    swapIn(written, target);
  } finally {
    rmSync(written, { recursive: true, force: true });
  }
}
