# ADR-0018 — Rename to AGBoss

- **Status:** Accepted (renames GraphCompose from ADR-0012)
- **Issue:** #167, #249

## Decision

- The framework is **AGBoss** — Agent Graph Builder Open Source Software: npm package `agboss`
  (subpaths unchanged in shape: `@agboss/core/dto`, `@agboss/core/testing`, `@agboss/core/units`, `@agboss/core/models`,
  `@agboss/core/mcp`, `@agboss/core/rag`, `@agboss/core/a2a`, `@agboss/core/memory`, plus the deprecated re-exports `/core`,
  `/graph`, `/router`, `/tool`, `/channels`, `/concurrency`), CLI command `agboss`, short alias `agb`
  (replacing `gc`); the repository `agbossjs/agboss` (GitHub redirects the old
  `PavelRavvich/graphcompose` links; that repo was itself transferred and renamed, not re-created, so
  issue numbers, PR history and stars carried over).
- Package directories renamed to match: `packages/graphcompose` → `packages/agboss`,
  `packages/graphcompose-cli` → `packages/agboss-cli`.
- Unlike ADR-0012 (pre-release, done without ceremony), this rename follows a real release history,
  so ADR-0012 and ADR-0011 keep the names they were written with — only this ADR and the current
  code/docs use the new name.

## Consequences

- `gc` was also the oh-my-zsh git plugin's alias for `git commit` (ADR-0012's reason for keeping a
  short alias at all); `agb` carries that forward without the collision.
- Every doc (`README.md`, `CLAUDE.md`, `QUALITY.md`, `WORKFLOW.md`, this Wiki) and script
  (`bootstrap-repo.sh`, `check-docs.mjs`'s command-reference checker, the API reports) needed its
  `graphcompose`/`gc` references updated in the same change, since `make check` typechecks every
  code block and verifies every mentioned command against the built package.
