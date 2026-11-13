import { join } from "node:path";
import { LinkedPathError, linkedWarning, outsideProject, outsideWarning } from "./containment.js";
import { syncCopy } from "./copy.js";
import { linkClaudeSkills, REAL_LINK_OPS, type LinkOps } from "./link.js";
import { skillsLines, skillsWarningText } from "./lines.js";
import { removeLeftovers, restoreLeftover } from "./leftovers.js";
import { DEFAULT_LOCK, LOCK_NAME, withSyncLock, type LockOptions } from "./lock.js";
import { readManifest } from "./manifest.js";
import { planSync } from "./plan.js";
import { REAL_REPLACE_OPS, type ReplaceOps } from "./replace.js";
import { shadowWarning } from "./shadow.js";
import {
  CLAUDE_SKILLS_LINK,
  SKILLS_FOLDER,
  SkillsSyncStatus,
  SkillsWarningCode,
  type SkillsSync,
  type SkillsWarning,
} from "./status.js";
import { skillFilesOf, skillsSourceOf, type SkillFile, type SkillsSource } from "./source.js";

export { skillsLines, skillsWarningText };

/**
 * The sync of a project's skills (#305, #983): `.agents/skills/agboss/` — the one committed copy
 * every coding agent reads — made equal to the skills of the `agboss` the project resolves, by
 * `agboss check` (so `npm install`'s postinstall and every `agboss dev` pass) and `agboss generate`.
 * A 0.1.x `.claude/skills/agboss/` folder is moved there; `.claude/skills/agboss` becomes a local
 * link to it, checked on every run. A version change replaces the folder, a missing or edited file
 * at the same version is repaired; files of the project's own are kept. Never an error: every
 * problem is a warning and the command goes on.
 */

/** The project the sync works on: its root and whether `"agboss": { "skills": false }` turned it off. */
export interface SkillsProject {
  readonly root: string;
  readonly isEnabled: boolean;
}

/** What a test may swap: the link's and the replace's file-system calls, the home folder. */
export interface SyncDeps {
  readonly link?: LinkOps;
  readonly replace?: ReplaceOps;
  readonly home?: () => string | undefined;
  readonly lock?: LockOptions;
}

/** What the command says when the folder cannot be written: `the check went on`. */
const goneOn = (command: string): string =>
  command === "check" ? "the check went on" : `agboss ${command} went on`;

const failed = (
  code: SkillsWarningCode,
  message: string,
  more: readonly SkillsWarning[] = [],
): SkillsSync => ({
  result: { status: SkillsSyncStatus.Failed, folder: SKILLS_FOLDER, written: [], removed: [] },
  warnings: [{ code, message }, ...more],
});

/** The source's absence as a warning: no `agboss` at all, or one older than the skills. */
const noFramework = (source: SkillsSource | undefined): SkillsSync =>
  failed(
    SkillsWarningCode.NoFramework,
    source === undefined
      ? "agboss is not installed in node_modules — skills not synced (npm install)"
      : `agboss ${source.version} ships no skills — skills not synced (upgrade agboss)`,
  );

/** The copy and its link, written while the project's sync lock is held. */
function writeProject(
  root: string,
  source: SkillsSource,
  files: readonly SkillFile[],
  ops: { readonly link: LinkOps; readonly replace: ReplaceOps },
): SkillsSync {
  restoreLeftover(root, join(root, SKILLS_FOLDER), ops.replace);
  const kept = removeLeftovers(root, files, ops.replace);
  const copy = syncCopy(root, files, source.version, ops);
  const link = copy.isMoveOpen ? undefined : linkClaudeSkills(root, ops.link);
  const result =
    link === undefined
      ? copy.result
      : { ...copy.result, link: { path: CLAUDE_SKILLS_LINK, status: link.status } };
  return { result, warnings: [...kept, ...copy.warnings, ...(link?.warnings ?? [])] };
}

/**
 * The sync that could not take the lock: another `agboss check` was writing for the whole wait.
 * What it left is read, not written: current says nothing, anything else is said once.
 */
function skippedProject(
  root: string,
  source: SkillsSource,
  files: readonly SkillFile[],
): SkillsSync {
  const target = join(root, SKILLS_FOLDER);
  const plan = planSync(target, readManifest(target), files, source.version);
  if (plan.status === SkillsSyncStatus.Current)
    return {
      result: {
        status: plan.status,
        version: source.version,
        folder: SKILLS_FOLDER,
        written: [],
        removed: [],
      },
      warnings: [],
    };
  return failed(
    SkillsWarningCode.SyncFailed,
    `${SKILLS_FOLDER} not written: another agboss check holds ${join(".agents", LOCK_NAME)} — run npx agboss check again`,
  );
}

/** The copy, its link and the shadow check of a project whose source is known. */
function syncProject(
  root: string,
  source: SkillsSource,
  ops: { readonly link: LinkOps; readonly replace: ReplaceOps; readonly lock: LockOptions },
  shadowed: readonly SkillsWarning[],
): SkillsSync {
  const outside = outsideProject(root, ops.link);
  if (outside !== undefined)
    return failed(SkillsWarningCode.OutsideProject, outsideWarning(outside).message, shadowed);
  const files = skillFilesOf(source);
  const held = withSyncLock(root, () => writeProject(root, source, files, ops), ops.lock);
  const done = held?.value ?? skippedProject(root, source, files);
  return { result: done.result, warnings: [...done.warnings, ...shadowed] };
}

/** What a sync that threw says: a refused link is `outside-project`, anything else `sync-failed`. */
function failureOf(
  error: unknown,
  command: string,
  shadowed: readonly SkillsWarning[],
): SkillsSync {
  if (error instanceof LinkedPathError)
    return failed(
      SkillsWarningCode.OutsideProject,
      linkedWarning(error.relative).message,
      shadowed,
    );
  const reason = error instanceof Error ? error.message : String(error);
  return failed(
    SkillsWarningCode.SyncFailed,
    `${SKILLS_FOLDER} not written: ${reason} — ${goneOn(command)}`,
    shadowed,
  );
}

/** Syncs the project's skills; `command` names who asked, for the warnings. */
export function syncSkills(
  project: SkillsProject,
  command: string,
  deps: SyncDeps = {},
): SkillsSync {
  if (!project.isEnabled)
    return {
      result: { status: SkillsSyncStatus.Off, folder: SKILLS_FOLDER, written: [], removed: [] },
      warnings: [],
    };
  const source = skillsSourceOf(project.root);
  if (source?.hasSkills !== true) return noFramework(source);
  const ops = {
    link: deps.link ?? REAL_LINK_OPS,
    replace: deps.replace ?? REAL_REPLACE_OPS,
    lock: deps.lock ?? DEFAULT_LOCK,
  };
  const shadow = shadowWarning(source.version, deps.home);
  const shadowed = shadow === undefined ? [] : [shadow];
  try {
    return syncProject(project.root, source, ops, shadowed);
  } catch (error) {
    return failureOf(error, command, shadowed);
  }
}
