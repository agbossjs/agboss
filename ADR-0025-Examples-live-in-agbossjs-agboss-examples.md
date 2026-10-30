# ADR-0025 — Examples live in agbossjs/agboss-examples

- **Status:** Accepted (#489)
- **Issue:** #489 (part of #420)
- **Supersedes:** the part of [ADR-0011](ADR-0011-graphInject-framework-package-and-examples-apart)
  that keeps `examples/job-scout` in the monorepo as "the only example"

## Context

ADR-0011 put the framework and its example in one monorepo as npm workspaces: `examples/job-scout`
depended on the framework by a workspace link and ran in `make check`. That kept the example honest
about the public API (ESLint enforces it), but not about what users install: the link pointed at
the workspace packages, never at the published `@agboss/core`, so nobody checked that job-scout
worked with a release. It also slowed the core's gate. Meanwhile
[agbossjs/agboss-examples](https://github.com/agbossjs/agboss-examples) grew seven standalone
examples (`01`..`07`) with rules of their own (R1–R6: a standalone folder with its own
`package.json`, no internals, `check` / `test` / `demo` offline at $0, isolated negative fixtures,
no secrets) and a CI that runs them on every push (`smoke`) and nightly against a pinned framework
commit.

## Decision

- **Standalone examples live in agbossjs/agboss-examples**, numbered, each on the published
  packages. job-scout moved there as
  [`08-job-scout`](https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout), its commit
  history kept (`git subtree split` / `subtree add`), its behaviour unchanged, its `demo` script
  offline on recorded cassettes and a fixture Greenhouse board, `demo:live` with a real model.
- **The core keeps one in-repo example, `examples/flow-patterns`**: the zero-cost harness of the
  public surface. Every check job-scout served in `make check` runs on it now — the root's
  `check:models` and `studio`, `agboss describe` (the desk application's snapshot), `agboss check
  --env`, `agboss studio` / `dev`, the generators on the shipped layout, the flow-style lint and the
  boundary test (`examples/` holds `flow-patterns` only).
- **Releases are verified locally with real models**: before every release (from `0.1.1`) the
  maintainer packs the candidate into agboss-examples and runs every example — `check`, `test`, the
  live demo — with a key (`RELEASE_CHECKLIST.md` → Examples against the release candidate). CI
  stays offline: no cross-repository trigger, no token of the core in the examples repository.
- **No stale link**: `check:docs` fails on a link to `examples/job-scout` in any doc or Wiki page
  but the ADRs and the Changelog, which keep their history (`scripts/docs/removed-paths.mjs`).

## Consequences

- An example proves itself against what users install; a breaking change shows in the examples
  repository's CI on the next push or nightly run, and in the release run before publishing.
- An example that needs an API added after the latest release waits for the next release instead of
  pinning a git dependency.
- The core's gate no longer builds or lints job-scout; a change to the framework that breaks it is
  found there, not in this repository's PR.
- Docs that describe how the system works link agbossjs/agboss-examples; snippets may still use
  job-scout's names (`job-scout-workflow`, `JobScoutApplication`) as labels.
