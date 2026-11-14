import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LinkedPathError, linkedBelow } from "./containment.js";
import type { LinkOps } from "./link.js";
import { readManifest, type SkillsManifest } from "./manifest.js";
import { planSync, type SyncPlan } from "./plan.js";
import type { KeptFile, ReplaceOps } from "./replace.js";
import type { SkillFile } from "./source.js";
import {
  CLAUDE_SKILLS_LINK,
  SKILLS_FOLDER,
  SkillsWarningCode,
  type SkillsWarning,
} from "./status.js";

/**
 * The move of a 0.1.x project's skills (#983): a real, managed `.claude/skills/agboss/` becomes
 * `.agents/skills/agboss/`. The old folder is removed only after the new one is swapped in, so a
 * crash in between leaves both and the next run finishes. Its plan is made against its own
 * manifest, so `previous`, `edited` and `unmanaged` work as they always did.
 */

/** What stands at `.claude/skills/agboss`, as far as the move cares. */
export type Legacy =
  /** Nothing, a link or a file: the link step deals with it. */
  | { readonly kind: "other" }
  /** A real folder without a manifest: the user's, never touched. */
  | { readonly kind: "unmanaged" }
  /** A real folder with a manifest: the previous install. */
  | { readonly kind: "managed"; readonly folder: string; readonly manifest: SkillsManifest };

/** Classifies the legacy path with `lstat`, so a link is not followed. */
export function legacyOf(root: string, ops: LinkOps): Legacy {
  const folder = join(root, CLAUDE_SKILLS_LINK);
  const found = ops.lstat(folder);
  if (found === undefined || found.isSymbolicLink() || !found.isDirectory())
    return { kind: "other" };
  const manifest = readManifest(folder);
  return manifest === undefined ? { kind: "unmanaged" } : { kind: "managed", folder, manifest };
}

/** The text of the move's warning: what moved, what to commit, what to fix in `.gitignore`. */
const MOVED = `${CLAUDE_SKILLS_LINK}/ moved to ${SKILLS_FOLDER}/ (one copy for every coding agent): commit ${SKILLS_FOLDER}/; ${CLAUDE_SKILLS_LINK} is now a local link to it — in .gitignore replace the old "${CLAUDE_SKILLS_LINK}/" line with "${CLAUDE_SKILLS_LINK}" (no trailing slash)`;

/** The plan of the old folder against its manifest, and what the new one keeps from it. */
export interface LegacyPlan {
  readonly plan: SyncPlan;
  readonly kept: readonly KeptFile[];
}

/** The old folder's plan and its unmanaged files, as files to carry over. */
export function legacyPlanOf(
  legacy: Extract<Legacy, { kind: "managed" }>,
  files: readonly SkillFile[],
  version: string,
): LegacyPlan {
  const plan = planSync(legacy.folder, legacy.manifest, files, version);
  return {
    plan,
    kept: plan.unmanaged.map((path) => ({ from: join(legacy.folder, path), path })),
  };
}

/** Removes the old folder and says it moved; a removal that fails leaves it for the next run. */
export function removeLegacy(folder: string, ops: ReplaceOps): SkillsWarning[] {
  try {
    ops.rm(folder);
    return [{ code: SkillsWarningCode.Moved, message: MOVED }];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        code: SkillsWarningCode.SyncFailed,
        message: `${CLAUDE_SKILLS_LINK}/ not removed: ${reason} — the next agboss check finishes the move`,
      },
    ];
  }
}

/**
 * Refuses (throws) when a file would be written below a link in `target`: a crafted or
 * half-migrated layout must not make the move write outside the project (#983 D2). Nothing is
 * written before every path is checked.
 */
export function assertCarryable(target: string, kept: readonly KeptFile[]): void {
  for (const file of kept) {
    const parent = dirname(file.path);
    const linked = parent === "." ? undefined : linkedBelow(target, parent);
    if (linked !== undefined) throw new LinkedPathError(`${SKILLS_FOLDER}/${linked}`);
  }
}

/** True when `a` and `b` are regular files of the same bytes. */
const sameFile = (a: string, b: string): boolean =>
  lstatSync(a, { throwIfNoEntry: false })?.isFile() === true &&
  lstatSync(b, { throwIfNoEntry: false })?.isFile() === true &&
  readFileSync(a).equals(readFileSync(b));

/**
 * Saves the old folder's `file`, which differs from the copy's `to`, as `<name>.legacy` beside it
 * (`.legacy.2` … when that name is another content's): the copy's file stays, nothing is lost.
 */
function saveLegacy(file: KeptFile, to: string): SkillsWarning {
  let copy = `${to}.legacy`;
  for (let n = 2; lstatSync(copy, { throwIfNoEntry: false }) !== undefined; n += 1) {
    if (sameFile(file.from, copy)) break;
    copy = `${to}.legacy.${String(n)}`;
  }
  if (lstatSync(copy, { throwIfNoEntry: false }) === undefined) copyFileSync(file.from, copy);
  return {
    code: SkillsWarningCode.UnmanagedFile,
    message: `${SKILLS_FOLDER}/${file.path} differs from ${CLAUDE_SKILLS_LINK}/${file.path} — kept the ${SKILLS_FOLDER} one; the old content is saved as ${SKILLS_FOLDER}/${copy.slice(to.length - file.path.length)}`,
  };
}

/**
 * Copies the old folder's own files the new one lacks (an interrupted move finishing). A file in
 * both with other bytes keeps the new folder's and saves the old one as `<name>.legacy`.
 */
export function carryOver(target: string, kept: readonly KeptFile[]): SkillsWarning[] {
  assertCarryable(target, kept);
  const warnings: SkillsWarning[] = [];
  for (const file of kept) {
    const to = join(target, file.path);
    // lstat: a dangling link at `to` is "there" — copying would write through it
    const there = lstatSync(to, { throwIfNoEntry: false });
    if (there !== undefined) {
      if (there.isFile() && !sameFile(file.from, to)) warnings.push(saveLegacy(file, to));
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file.from, to);
  }
  return warnings;
}
