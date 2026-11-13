# ADR-0029 — Skills in .agents/skills/agboss with a Claude link

- **Status:** Accepted
- **Issue:** #983 (refines ADR-0021, #305)

## Context

ADR-0021 put the project skills in `.claude/skills/agboss/`, which only Claude Code (and Cursor,
Copilot and Cline, which also scan Claude's folder) read. Codex CLI, Gemini CLI / Antigravity and
Windsurf (Devin Desktop) do not. The skills are already in the open Agent Skills format
(agentskills.io), which every one of these agents reads; only the folder was Claude-specific.
`.agents/skills/` is the cross-client convention: Codex, Cursor, Copilot, Gemini CLI, Antigravity and
Windsurf scan it natively. Claude Code and Cline do not (checked by hand with Claude Code 2.1.323).

## Decision

- The one managed copy is `.agents/skills/agboss/`, and it is **committed**: the skills are part of
  the project ("this is part of the project", maintainer, 2026-11-13).
- `.claude/skills/agboss` is a **link** to it — a relative symlink, on Windows a junction (no rights
  needed) — made locally by `npm install` (postinstall) / `agboss check` / `agboss create`, and
  git-ignored (`.claude/skills/agboss`, no trailing slash: git's trailing-slash pattern matches
  directories only). A committed link would break on Windows with `core.symlinks=false`. Price: after
  `git clone` and before the first `npm install` or `agboss check`, Claude Code and Cline do not see
  the skill; every other agent does.
- A link that cannot be made is a warning (`[skills.link-failed]`, with the command to run), never a
  second copy. A `.claude/skills/agboss` that is the project's is kept (`[skills.link-blocked]`). No
  `skills.claude` opt-out key. The CLI never edits `.gitignore`. Nothing for Gemini beyond the folder.
- A 0.1.x project's real `.claude/skills/agboss/` is moved on the first sync (`[skills.moved]`),
  removed only after the new folder is swapped in, so a crash leaves both and the next run finishes.
- The atomic swap's temporary folder lives in `.agents/`, not in `skills/` (agents scan every child of
  `skills/`; a leftover would be a second `agboss` skill); leftovers are removed on the next run.
  `EPERM` / `EBUSY` renames are retried a bounded number of times.
- Hashes are compared with CRLF read as LF, and `agboss create` writes `.gitattributes`
  (`.agents/skills/agboss/** text eol=lf`), so a Windows checkout is no local edit.
- A personal `~/.claude/skills/agboss` of another version, which Claude Code prefers over the
  project's, is `[skills.shadowed]`. `~/.agents/skills/agboss` is not checked: project skills override
  user ones in the Agent Skills client guide.
- `SKILL.md`'s frontmatter is `name`, `description`, `license`, `metadata.agboss-version`: the common
  subset of the spec, Codex, Cursor, Copilot and Gemini; `check:docs` enforces it (the equivalent of
  the Agent Skills reference validator; no new dependency).

Rejected: no `.claude` entry (Claude Code loses discovery, Cline too); a Claude-only stub `SKILL.md`
(two different skills named `agboss` in Cursor and Copilot); a second managed copy as the fallback
(the N-copies problem on exactly the machines that cannot link); the CLI editing `.gitignore`
(a user file).

## Consequences

- One copy on disk, every agent finds the skill; the old `.claude/skills/agboss/...` paths in an
  existing `AGENTS.md` keep resolving through the link.
- Whether Cursor and Copilot list the skill twice when they scan both folders is not documented; it is
  checked by hand (#983 M3, M4) and would only make the link optional or opt-out-able later.
- APM packaging of the skills (#856) must later target `.agents/skills/agboss/`.
