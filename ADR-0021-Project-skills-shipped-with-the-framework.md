# ADR-0021 — Project skills shipped with the framework

- **Status:** Accepted
- **Issue:** #305

## Context

Projects are written and changed by coding agents (Claude Code, Cursor, Codex). Their models do not
know the current AGBoss API — the flow DSL of #272, `about` / `historyOf`, `@Application`-only entry
points, frame-bound `ExecutionContext` — and fall back to older syntax, raw LangGraph or forbidden
casts. A guide helps only when it matches the `agboss` version the project compiles against, and
only when it is where the agent looks: Claude Code reads `CLAUDE.md` and `.claude/skills/<name>/SKILL.md`
(YAML frontmatter first), Cursor and Codex read `AGENTS.md`.

## Decision

- The skills live in the framework package — `packages/agboss/skills/agboss/` (`SKILL.md` and 12
  references), `"skills"` in its `files` — so every release carries the guide of its own API, offline.
  A root-level `skills/` would break the repository's root allowlist.
- `agboss create` writes `AGENTS.md` (the project's instructions and a routing table), a one-line
  `CLAUDE.md` (`@AGENTS.md`) and the skills with a manifest (`.agboss-skills.json`: version + sha256
  per file). `AGENTS.md` and `CLAUDE.md` belong to the project: written once, never rewritten.
- `agboss check` (so the existing `postinstall` and every `agboss dev` pass) and `agboss generate`
  sync `.claude/skills/agboss/` with the skills of the `agboss` the project resolves: another
  version replaces the folder, a missing or hand-edited file at the same version is repaired, the
  project's own files are kept. Written to a temporary folder and renamed into place. Its problems
  are warnings; the exit code is the check's. `"agboss": { "skills": false }` turns it off.
- The managed folder is git-ignored in generated projects: it is the package's, regenerated on install.
- Every snippet of the skills compiles in `npm run check:docs`, which also checks the version
  header, the codes they mention, the names of their matrix (exported by a public entry) and,
  once complete, the error catalog against `RuleCode`.

Rejected: `"prepare": "agboss check"` (a second run beside `postinstall`, also on `npm pack`);
`AGENTS.md` only (Claude Code reads `CLAUDE.md`); pulling skills over the network between releases
(docs of API the installed version lacks, agent-steering text from outside the package); committing
the managed folder (13-file diffs per upgrade, CI rewriting tracked files).

## Consequences

- An upgrade of `agboss` updates the guide with no step of its own; a skill fix ships as a patch release.
- A wrong snippet or a renamed name fails the gate, so the skills cannot drift from the code.
- A project that edits a managed file loses the edit on the next check (with a warning): project
  rules go into `AGENTS.md`.
