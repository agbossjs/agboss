import { skillsLines, skillsWarningText, syncSkills } from "../skills/sync.js";
import type { SkillsSyncResult } from "../skills/status.js";
import { skillsProjectOf } from "./application-path.js";
import type { CommandContext } from "./context.js";

/**
 * The project skills' sync of a command (#305): `agboss check` (before the assembly) and
 * `agboss generate` (before writing) — its lines printed, its result and warnings for `--json`.
 * Outside an AGBoss project nothing happens.
 */
export interface CommandSkills {
  /** `result.skills`; undefined outside an AGBoss project. */
  readonly result?: SkillsSyncResult;
  /** The envelope's warnings: `[skills.local-edit] …`. */
  readonly warnings: readonly string[];
}

/** Syncs the skills of the project the command runs in and prints what it did. */
export function syncCommandSkills(context: CommandContext): CommandSkills {
  const project = skillsProjectOf(context.io.cwd);
  if (project === undefined) return { warnings: [] };
  const sync = syncSkills(project, context.command);
  skillsLines(sync).forEach(context.say);
  return { result: sync.result, warnings: sync.warnings.map(skillsWarningText) };
}

/** `{ skills }` for a command's result, nothing when there was no sync. */
export const skillsField = (skills: CommandSkills): { readonly skills?: SkillsSyncResult } =>
  skills.result === undefined ? {} : { skills: skills.result };
