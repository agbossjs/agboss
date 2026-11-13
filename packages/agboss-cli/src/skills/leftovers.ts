import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LOCK_NAME } from "./lock.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import { renameRetrying, REAL_REPLACE_OPS, type ReplaceOps } from "./replace.js";
import { filesUnder, type SkillFile } from "./source.js";
import { CLAUDE_SKILLS_LINK, SKILLS_FOLDER, SkillsWarningCode, TEMP_PREFIX } from "./status.js";
import type { SkillsWarning } from "./status.js";

/**
 * What a crashed swap leaves (#983 D1): `.agents/.agboss-skills-<random>` (the new folder) and
 * `-old` (the previous one) — and in `.claude/skills/` the same names 0.1.x wrote. A crash between
 * the swap's two renames leaves no `.agents/skills/agboss` at all and the project's own files only
 * here: the next sync restores the newest complete leftover first, and a leftover is deleted only
 * when nothing of the project's is lost with it.
 */

/** A temporary folder untouched this long belongs to a crashed run, not to one writing right now. */
const LEFTOVER_AGE_MS = 5 * 60 * 1000;

const isLeftover = (name: string): boolean =>
  name.startsWith(TEMP_PREFIX) && !name.startsWith(LOCK_NAME);

/** The leftovers of `folder` (absolute paths), newest first; the name breaks a tie. */
function leftoversIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(isLeftover)
    .map((name) => join(folder, name))
    .filter((path) => lstatSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || (a < b ? 1 : -1));
}

/** True when nothing of anyone's is at `target`: missing, or an empty folder. */
function isEmptyPlace(target: string): boolean {
  const found = lstatSync(target, { throwIfNoEntry: false });
  if (found === undefined) return true;
  return found.isDirectory() && readdirSync(target).length === 0;
}

/**
 * Puts the newest complete leftover (one with a manifest) back at `.agents/skills/agboss` when that
 * folder is gone, so the plan that follows sees the project's own files. A folder that exists and
 * has a manifest, or has files of the user's, is never replaced.
 */
export function restoreLeftover(root: string, target: string, ops: ReplaceOps): void {
  if (readManifest(target) !== undefined || !isEmptyPlace(target)) return;
  const found = leftoversIn(join(root, ".agents")).find((path) => readManifest(path) !== undefined);
  if (found === undefined) return;
  if (existsSync(target)) ops.rm(target);
  renameRetrying(found, target, ops);
}

const sameBytes = (a: string, b: string): boolean =>
  existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

/** The files of a leftover that are the project's own and exist nowhere else: deleting it loses them. */
function lostWith(
  leftover: string,
  lives: readonly string[],
  files: readonly SkillFile[],
): string[] {
  const known = new Set([
    ...Object.keys(readManifest(leftover)?.files ?? {}),
    ...lives.flatMap((live) => Object.keys(readManifest(live)?.files ?? {})),
    ...files.map((file) => file.path),
  ]);
  return filesUnder(leftover)
    .filter((path) => path !== MANIFEST_FILE && !known.has(path))
    .filter((path) => !lives.some((live) => sameBytes(join(leftover, path), join(live, path))));
}

/**
 * Removes the leftovers idle for minutes (another `agboss check` may be mid-write) — except one
 * that holds files of the project's own which the live folder lacks: kept, with a warning naming it.
 */
export function removeLeftovers(
  root: string,
  files: readonly SkillFile[],
  ops: ReplaceOps = REAL_REPLACE_OPS,
): SkillsWarning[] {
  const lives = [join(root, SKILLS_FOLDER), join(root, CLAUDE_SKILLS_LINK)];
  const warnings: SkillsWarning[] = [];
  for (const folder of [join(root, ".agents"), join(root, ".claude", "skills")]) {
    for (const path of leftoversIn(folder)) {
      if (Date.now() - statSync(path).mtimeMs <= LEFTOVER_AGE_MS) continue;
      const lost = lostWith(path, lives, files);
      if (lost.length === 0) ops.rm(path);
      else
        warnings.push({
          code: SkillsWarningCode.UnmanagedFile,
          message: `${relative(root, path)} holds your own files (${lost.join(", ")}) that ${SKILLS_FOLDER} lacks — kept; copy them back or remove the folder`,
        });
    }
  }
  return warnings;
}
