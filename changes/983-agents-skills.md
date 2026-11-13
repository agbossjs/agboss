---
section: Added
issue: 983
---

**The project skills are one copy in `.agents/skills/agboss/`, which every coding agent reads**
(#983, supersedes the location of #305) — `agboss create` and `agboss check` write the skills to
the open Agent Skills location: Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Antigravity and
Windsurf discover `agboss` there natively. The folder is part of the project and is committed;
`.claude/skills/agboss` becomes a local link to it (a symlink, on Windows a junction) so Claude
Code and Cline still find the skill, made on each machine by `npm install` / `agboss check` and
git-ignored (`.claude/skills/agboss`, no trailing slash). `SKILL.md`'s frontmatter is now `name`,
`description`, `license` and `metadata.agboss-version`, the fields every agent accepts.

- **Existing project:** the first `agboss check` moves a real `.claude/skills/agboss/` folder to
  `.agents/skills/agboss/` (your own files in it kept) and warns once — `[skills.moved]`: commit
  `.agents/skills/agboss/`, and in `.gitignore` replace `.claude/skills/agboss/` with
  `.claude/skills/agboss`. The CLI never edits `.gitignore`.
- **Warnings, never a failure:** `[skills.link-blocked]` (a `.claude/skills/agboss` that is yours),
  `[skills.link-failed]` (the link could not be made — the warning prints the `ln -s` / `mklink /J`
  to run; never a second copy), `[skills.outside-project]` (a `.claude`, `.claude/skills`, `.agents` or `.agents/skills` that is a link leaving the project: nothing is touched), `[skills.shadowed]` (a `~/.claude/skills/agboss` of another
  version, which Claude Code prefers). `--json` `result.skills` gains `link` and `moved`.
- **Safer sync:** the link is checked on every run, also when the copy is current; the atomic swap's
  temporary folder lives in `.agents/` (a leftover is removed on the next run); `EPERM` / `EBUSY`
  renames are retried; a CRLF checkout of a managed file is no local edit, and `agboss create`
  writes a `.gitattributes` line keeping the folder LF.
