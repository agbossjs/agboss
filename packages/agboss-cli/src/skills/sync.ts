import { join } from "node:path";
import { readManifest } from "./manifest.js";
import { replaceSkillsFolder } from "./replace.js";
import {
  SKILLS_FOLDER,
  SkillsSyncStatus,
  SkillsWarningCode,
  type SkillsSync,
  type SkillsSyncResult,
  type SkillsWarning,
} from "./status.js";
import { planSync, type SyncPlan } from "./plan.js";
import { skillFilesOf, skillsSourceOf, type SkillsSource } from "./source.js";

/**
 * The sync of a project's skills (#305): `.claude/skills/agboss/` made equal to the skills of the
 * `agboss` the project resolves, by `agboss check` (so `npm install`'s postinstall and every
 * `agboss dev` pass) and `agboss generate`. A version change replaces the folder, a missing or
 * hand-edited file at the same version is repaired; files of the project's own are kept. Never an
 * error: every problem is a warning and the command goes on.
 */

/** The project the sync works on: its root and whether `"agboss": { "skills": false }` turned it off. */
export interface SkillsProject {
  readonly root: string;
  readonly isEnabled: boolean;
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

/** The warnings of a plan that writes: hand edits replaced, the project's own files kept. */
function planWarnings(plan: SyncPlan, version: string): SkillsWarning[] {
  return [
    ...plan.edited.map((path) => ({
      code: SkillsWarningCode.LocalEdit,
      message: `${SKILLS_FOLDER}/${path} was edited — replaced by agboss ${version}'s; put project rules in AGENTS.md`,
    })),
    ...plan.unmanaged.map((path) => ({
      code: SkillsWarningCode.UnmanagedFile,
      message: `${SKILLS_FOLDER}/${path} is not agboss's — kept; put project rules in AGENTS.md`,
    })),
  ];
}

/** The result of a plan, as `--json` carries it. */
const resultOf = (plan: SyncPlan, version: string, previous?: string): SkillsSyncResult => ({
  status: plan.status,
  version,
  ...(previous === undefined || previous === version ? {} : { previous }),
  folder: SKILLS_FOLDER,
  written: plan.written,
  removed: plan.removed,
});

/** Syncs the project's skills; `command` names who asked, for the warnings. */
export function syncSkills(project: SkillsProject, command: string): SkillsSync {
  if (!project.isEnabled)
    return {
      result: { status: SkillsSyncStatus.Off, folder: SKILLS_FOLDER, written: [], removed: [] },
      warnings: [],
    };
  const source = skillsSourceOf(project.root);
  if (source?.hasSkills !== true) return noFramework(source);
  const target = join(project.root, SKILLS_FOLDER);
  try {
    const files = skillFilesOf(source);
    const manifest = readManifest(target);
    const plan = planSync(target, manifest, files, source.version);
    const result = resultOf(plan, source.version, manifest?.version);
    if (plan.status === SkillsSyncStatus.Current) return { result, warnings: [] };
    replaceSkillsFolder(target, files, source.version, plan.unmanaged);
    return { result, warnings: planWarnings(plan, source.version) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failed(
      SkillsWarningCode.SyncFailed,
      `${SKILLS_FOLDER} not written: ${reason} — ${goneOn(command)}`,
    );
  }
}

const countOf = (files: readonly string[]): string =>
  `${String(files.length)} file${files.length === 1 ? "" : "s"}`;

/** The line a sync prints; none when nothing was written. */
function statusLine(result: SkillsSyncResult): string | undefined {
  const written = countOf(result.written);
  switch (result.status) {
    case SkillsSyncStatus.Installed:
      return `skills: ${result.folder} installed for agboss ${result.version ?? ""} (${written})`;
    case SkillsSyncStatus.Updated:
      return `skills: ${result.folder} updated ${result.previous ?? "?"} → ${result.version ?? ""} (${written})`;
    case SkillsSyncStatus.Repaired:
      return `skills: ${result.folder} repaired (${countOf([...result.written, ...result.removed])})`;
    case SkillsSyncStatus.Current:
    case SkillsSyncStatus.Off:
    case SkillsSyncStatus.Failed:
      return undefined;
    default: {
      const unknown: never = result.status;
      return unknown;
    }
  }
}

/** A warning as the CLI prints it and `--json` lists it: `[skills.local-edit] …`. */
export const skillsWarningText = (warning: SkillsWarning): string =>
  `[${warning.code}] ${warning.message}`;

/** What a sync prints: its warnings, then what it wrote. */
export function skillsLines(sync: SkillsSync): readonly string[] {
  const line = statusLine(sync.result);
  return [
    ...sync.warnings.map((warning) => `warning: ${skillsWarningText(warning)}`),
    ...(line === undefined ? [] : [line]),
  ];
}
