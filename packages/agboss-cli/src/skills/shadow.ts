import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SkillsWarningCode, type SkillsWarning } from "./status.js";

/**
 * The shadow check (#983, read-only): Claude Code prefers a personal skill `~/.claude/skills/agboss`
 * over the project's, so one of another agboss version silently wins. The home folder comes from
 * `os.homedir()` (`USERPROFILE` on Windows); none, or one that cannot be read, is no warning and
 * no error. `~/.agents/skills/agboss` is not checked: project skills override user ones there.
 */

/** `<!-- agboss-skills-version: 0.1.1 — … -->` or the frontmatter's `agboss-version: "0.1.1"`. */
function versionIn(skill: string): string | undefined {
  const header = /<!-- agboss-skills-version: (\S+) —/.exec(skill)?.[1];
  return header ?? /^\s+agboss-version:\s*"?([^"\s]+)"?\s*$/m.exec(skill)?.[1];
}

/** The user's home folder; undefined when the OS gives none. */
function homeFolder(): string | undefined {
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

/** The warning for a personal agboss skill of another version than `version`, if there is one. */
export function shadowWarning(
  version: string,
  home: () => string | undefined = homeFolder,
): SkillsWarning | undefined {
  try {
    const folder = home();
    if (folder === undefined) return undefined;
    const skill = readFileSync(join(folder, ".claude", "skills", "agboss", "SKILL.md"), "utf8");
    const found = versionIn(skill);
    if (found === version) return undefined;
    return {
      code: SkillsWarningCode.Shadowed,
      message: `~/.claude/skills/agboss is agboss ${found ?? "of an unknown version"} — Claude Code uses a personal skill over the project's (${version}); remove it: rm -rf ~/.claude/skills/agboss`,
    };
  } catch {
    return undefined;
  }
}
