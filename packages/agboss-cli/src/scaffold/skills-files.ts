import { linkClaudeSkills } from "../skills/link.js";
import { skillsWarningText } from "../skills/lines.js";
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
 * rewritten — and the skills of the CLI's own `agboss` in `.agents/skills/agboss/` (the one copy, committed;
 * #983) with their manifest, written as they ship (never formatted: `agboss check` compares their hashes) — and
 * graphify's two project files (#480): `.graphifyignore`, `.graphifyrc`, for the optional code graph.
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
    { path: ".graphifyignore", content: render("project/graphifyignore.tmpl", {}) },
    { path: ".graphifyrc", content: render("project/graphifyrc.tmpl", {}) },
    // a checkout with CRLF would turn every skill file into a local edit (#983)
    { path: ".gitattributes", content: render("project/gitattributes.tmpl", {}) },
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

/**
 * The link `.claude/skills/agboss` → the written skills (#983), made after the files are on disk
 * (the files list holds files only). Never an error: the warning lines say what to run instead.
 */
export function linkProjectSkills(root: string): readonly string[] {
  return linkClaudeSkills(root).warnings.map((warning) => `warning: ${skillsWarningText(warning)}`);
}
