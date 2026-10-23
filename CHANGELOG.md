# Changelog

All notable changes to the `agboss` and `agboss-cli` packages, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form; versions follow
[Semantic Versioning](https://semver.org/) (before 1.0 a minor release may break the API).

This file is the summary of each release. The detailed log — one entry per merged pull request,
with every breaking change, its reason and the migration — is the Wiki's
[Changelog](https://github.com/agbossjs/agboss/wiki/Changelog); the exact public surface of each
entry point is in `packages/agboss/api/*.api.md`. Security fixes are announced here too
([`SECURITY.md`](SECURITY.md)).

## [Unreleased]

The first release of the framework. Everything below is new compared with the `0.0.1` placeholder;
the Wiki's Changelog lists the breaking changes made between pull requests on the way.

### Added

- **Applications and dependency injection** — `@Application` with its workflows, infrastructure,
  budgets, defaults and environment contract; one container per application instance with
  constructor injection (`deps`), lifecycle hooks and `createApp(App)` → `app.execute` / `resume` /
  `cancel` / `close` (#261).
- **The flow as paths** — `@Workflow({ flow })` with `start(…)`, `.returns(…)`, `.toAgent` /
  `.toRouter` / `.toAction` / `.toFinish`, `.chooseOne`, `.switch(caseOf(…))`, `.onError`, typed by
  the generated `.agboss/types.d.ts`, every assembly rule reported at once before any model call
  (#272, #270, #299); outdated values tracked on the path scope (#271).
- **Components** — `@Agent` (its own tool loop), `@Router` decided by a model or by code (#280),
  `@Action`, `@Tool`, `@WorkflowStart` / `@WorkflowFinish`, DTO classes (`agboss/dto`) for every
  value that crosses a boundary.
- **Parallel work** — parallel launches and joins (#273), quorums with arbiters (#279), child
  workflows (#263), recursion with `ThisWorkflow` and `maxDepth`, the tree's and the instance's
  concurrency caps (#264, #332).
- **Pauses and approvals** — channel roles, durable pauses answered by id, free-text replies read by
  reply interpreters, pause answer records (#267).
- **Declared compensation** — `compensateWith` / `committedBy`, checked at assembly, and the
  automatic undo of a failed join or a failed execution, finished by recovery (#339, #340).
- **Several instances** — the execution lease with fencing, recovery of interrupted executions, the
  graceful stop, SQLite implementations of every store, health checks (`app.checkLiveness()` /
  `app.checkReadiness()`) (#265, #335, #360, #367, #300).
- **Models and FinOps** — model providers as infrastructure (OpenRouter and the Decisions API built
  in) with retry, rate-limit and circuit-breaker policies; `@Budget`s per execution, tenant and
  application; cost accounting of every model call (#266, #261, #338).
- **Safety and quality** — PII policies masked at the model boundary, input and output guardrails
  decided by a model or by code, judges on an agent's answer as its DTO, memory compaction with
  built-in or custom strategies (#120, #262, #382, #383).
- **Testing** — `testWith(App)` with scripted models, the virtual clock, deterministic ids, class
  matchers, recorded runs and unit runners for every component kind (#262, #313); tool-call
  trajectories on results, records and `JudgeInput`, and one record per step (#395).
- **Eval suites** — `@EvalSuite` (`agboss/eval`) with typed cases, trajectory checks and code or
  model judges under a declared cascade; `agboss eval run --suite <name> --runs <k> --report
<run.json>` runs each case k times on the application and reports pass@k / pass^k per case, the
  unstable ones flagged, into a run artifact (`agboss.eval-run`); `agboss check` assembles the suites
  (#396). `--html <file>` and `agboss eval show <run.json> --html <file>` render a run as one
  self-contained HTML page — summary, unstable cases, attempt dots and every run's checks (#397).
- **The CLI** (`agboss-cli`) — `agboss create`, `agboss generate`, `agboss check`,
  `agboss describe`, `agboss dev`, `agboss studio`, `agboss chat` / `agboss run`, evaluations and
  comparisons (#268). Breaking on the way (#396): the bare `agboss eval` is now `agboss eval score`
  (`agboss eval` lists its subcommands `run` / `score` and exits 2).
- **Skills for coding agents** — `SKILL.md` and twelve references shipped in the package and synced
  into a project by `agboss check` (#305).

## [0.0.1] - 2026-10-10

### Added

- A placeholder published to npm to reserve the `agboss` name; it holds no framework code.

[Unreleased]: https://github.com/agbossjs/agboss/commits/main
[0.0.1]: https://www.npmjs.com/package/agboss/v/0.0.1
