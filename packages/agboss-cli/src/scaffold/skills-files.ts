import { manifestOf, manifestText, MANIFEST_FILE } from "../skills/manifest.js";
import { cliSkillsSource, skillFilesOf } from "../skills/source.js";
import { SKILLS_FOLDER } from "../skills/status.js";
import { applicationPathOf } from "./application-files.js";
import { ScaffoldError } from "./errors.js";
import type { Names } from "./names.js";
import { render } from "./plan.js";
import type { FileToWrite } from "./write.js";

/**
 * What `agboss create` writes for coding agents (#305): `AGENTS.md` (Cursor, Codex, …) and a
 * one-line `CLAUDE.md` importing it (Claude Code) — both the project's, written once and never
 * rewritten — and the skills of the CLI's own `agboss` in `.claude/skills/agboss/` with their
 * manifest, written as they ship (never formatted: `agboss check` compares their hashes).
 */
export function codingAgentFiles(project: Names): FileToWrite[] {
  const source = cliSkillsSource();
  if (source?.hasSkills !== true)
    throw new ScaffoldError(
      "the agboss package of this CLI ships no skills — reinstall agboss-cli",
    );
  const skills = skillFilesOf(source);
  const variables = { title: project.title, application: applicationPathOf(project) };
  return [
    { path: "AGENTS.md", content: render("project/AGENTS.md.tmpl", variables) },
    { path: "CLAUDE.md", content: render("project/CLAUDE.md.tmpl", {}) },
    ...skills.map((file) => ({
      path: `${SKILLS_FOLDER}/${file.path}`,
      content: file.content,
      isVerbatim: true,
    })),
    {
      path: `${SKILLS_FOLDER}/${MANIFEST_FILE}`,
      content: manifestText(manifestOf(source.version, skills)),
      isVerbatim: true,
    },
  ];
}
