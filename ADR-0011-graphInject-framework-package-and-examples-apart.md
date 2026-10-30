# ADR-0011 — graphInject: framework package and examples apart

- **Status:** Accepted — the in-repo `examples/job-scout` superseded by
  [ADR-0025](ADR-0025-Examples-live-in-agbossjs-agboss-examples) (#489)
- **Issue:** #91

## Context

The repo is becoming a framework other projects add as a dependency. Framework and example code were
mixed in one `src/`, with several demo sets of agents and a default one.

## Decision

- npm workspaces: `packages/graphinject` (the framework, npm package `graphinject`, built to
  `dist/`, bin `graphinject`) and `examples/job-scout` (the only example, depends on `graphinject`).
- A set of related agents under one directory is a **workflow** (`@Workflow`); commands find it by
  path: `graphinject <command> --workflow ./src/x.workflow.ts` (the CLI registers `tsx`: decorators
  need transpiling).
- The boundary is enforced both ways by ESLint: the framework never imports `examples/`; an example
  imports only `graphinject`. The framework ships no agents; its tests use test workflows.

## Consequences

- The example sees the framework as an outside project does; gaps in the public API show at once.
- A build step: `npm run build` (or `npm run dev`) before running the example.
- Terns keep a `bundle` column internally (no migration); everything user-facing says workflow.
