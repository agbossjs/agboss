import { syncCopy } from "./copy.js";
import { linkClaudeSkills, REAL_LINK_OPS, type LinkOps } from "./link.js";
import { skillsLines, skillsWarningText } from "./lines.js";
import { REAL_REPLACE_OPS, removeLeftovers, type ReplaceOps } from "./replace.js";
import { shadowWarning } from "./shadow.js";
import {
  CLAUDE_SKILLS_LINK,
  SKILLS_FOLDER,
  SkillsSyncStatus,
  SkillsWarningCode,
  type SkillsSync,
  type SkillsWarning,
} from "./status.js";
import { skillFilesOf, skillsSourceOf, type SkillsSource } from "./source.js";

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
}

/** What the command says when the folder cannot be written: `the check went on`. */
const goneOn = (command: string): string =>
  command === "check" ? "the check went on" : `agboss ${command} went on`;

const failed = (code: SkillsWarningCode, message: string): SkillsSync => ({
  result: { status: SkillsSyncStatus.Failed, folder: SKILLS_FOLDER, written: [], removed: [] },
  warnings: [{ code, message }],
});

/** The source's absence as a warning: no `agboss` at all, or one older than the skills. */
const noFramework = (source: SkillsSource | undefined): SkillsSync =>
  failed(
    SkillsWarningCode.NoFramework,
    source === undefined
      ? "agboss is not installed in node_modules — skills not synced (npm install)"
      : `agboss ${source.version} ships no skills — skills not synced (upgrade agboss)`,
  );

/** The copy, its link and the shadow check of a project whose source is known. */
function syncProject(
  root: string,
  source: SkillsSource,
  ops: { readonly link: LinkOps; readonly replace: ReplaceOps },
  shadowed: readonly SkillsWarning[],
): SkillsSync {
  removeLeftovers(root, ops.replace);
  const copy = syncCopy(root, skillFilesOf(source), source.version, ops);
  const link = copy.isMoveOpen ? undefined : linkClaudeSkills(root, ops.link);
  const result =
    link === undefined
      ? copy.result
      : { ...copy.result, link: { path: CLAUDE_SKILLS_LINK, status: link.status } };
  return { result, warnings: [...copy.warnings, ...(link?.warnings ?? []), ...shadowed] };
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
  const ops = { link: deps.link ?? REAL_LINK_OPS, replace: deps.replace ?? REAL_REPLACE_OPS };
  const shadow = shadowWarning(source.version, deps.home);
  const shadowed = shadow === undefined ? [] : [shadow];
  try {
    return syncProject(project.root, source, ops, shadowed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const done = failed(
      SkillsWarningCode.SyncFailed,
      `${SKILLS_FOLDER} not written: ${reason} — ${goneOn(command)}`,
    );
    return { ...done, warnings: [...done.warnings, ...shadowed] };
  }
}
