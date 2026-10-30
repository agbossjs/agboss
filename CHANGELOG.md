# Changelog

All notable changes to the `@agboss/core` and `@agboss/cli` packages, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form; versions follow
[Semantic Versioning](https://semver.org/) (before 1.0 a minor release may break the API).

This file is the summary of each release. The detailed log — one entry per merged pull request,
with every breaking change, its reason and the migration — is the Wiki's
[Changelog](https://github.com/agbossjs/agboss/wiki/Changelog); the exact public surface of each
entry point is in `packages/agboss/api/*.api.md`. Security fixes are announced here too
([`SECURITY.md`](SECURITY.md)).

## [Unreleased] — 0.1.1

### Added

- **Handover telemetry: the lease log** (#501) — a takeover of a tree's lease is told and kept:
  `onExecutionLeaseTakeover` (`ExecutionLeaseTakeoverEvent`: the new holder and token, the expired
  holder when the store names it — `ExecutionLease.takenOverFrom`, optional for an external store —,
  `LeaseTakeoverReason`, the head checkpoint) and a `Takeover` row of the new infrastructure contract
  `ExecutionLeaseEventRepository` (in-memory default, `SqliteExecutionLeaseEventRepository`, the
  published `executionLeaseEventContract`), always written, read with `app.leaseEventsOf({ tenantId,
rootExecutionId })` and removed by the recovery sweep after `@Application({ leaseEventRetention })`
  (default `hours(24)`). A step handed over (a lost lease, a fenced write, the app's stop) is told
  and kept too: `onStepHandedOver` (`StepHandedOverEvent`, `HandOverReason`, `HandOverSite`) and a
  `HandedOver` row, once per error at the innermost site, written before the moving call rejects;
  a kept `ExecutionHistoryRecord` carries its tree's rows as `leaseEvents` (and so does
  `agboss records export`). Every call of a fenced effect from a step is told and kept as well:
  `onFencedEffect` (`FencedEffectEvent`, `FencedEffectEventOutcome`: ran, replayed, joined,
  refused — never the result) and a `FencedEffect` row, so the public log alone tells a zombie
  refused at its write from one that never reached it, and a replay from a new write.
  `FencedEffectAsyncWorkError` moved to the SQLite store's module (still exported from the root).

### Fixed

- **A test that hangs fails fast** (#509): `testWith` bounds each app's close at the end of a test to
  10 s of real time — a run still frozen there (a step, a stalled lease, a wait on the
  `VirtualClock` nobody advances) fails the test with `AppCloseTimeoutError` (`test.close-timeout`,
  `@agboss/core/testing`) instead of hanging the run: vitest bounds no fixture's teardown.
- **`workflowOf(W)` on the package installed from npm** — the application next to `W` was imported
  by Node, outside vitest (no decorators). A vitest preset, `agbossTest()` from
  `@agboss/core/testing/vitest`, loads AGBoss and every file it loads by path through vite, in the
  test's module graph, and registers the matchers; `agboss create` writes it. Without it
  `workflowOf(W)` throws `TestSetupError` naming the fix. An existing project changes one line:
  `test: agbossTest({ … })` in `vitest.config.ts` (the `setupFiles` entry may go). CI checks the
  packed packages in a project of their own (`npm run check:packed`) (#497).

## [Unreleased] — 0.1.0 (`v0.1.0-rc` Pre-Release Candidate)

The first substantive release of the framework (`0.1.0`, prepared for manual owner publication; not yet published to `registry.npmjs.org`). Everything below is new compared with the `0.0.1` placeholder;
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
  `@Action`, `@Tool`, `@WorkflowStart` / `@WorkflowFinish`, DTO classes (`@agboss/core/dto`) for every
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
  `app.checkReadiness()`) (#265, #335, #360, #367, #300). Execution history (#401): with
  `@Application({ executionRecordRetention })` every root execution's record — with its identity,
  masked like its traces — is kept in the new `ExecutionHistoryRepository` (in memory or
  `SqliteExecutionHistoryRepository`) and swept after it; `agboss records export` writes it as JSON
  Lines.
- **Models and FinOps** — model providers as infrastructure (OpenRouter and the Decisions API built
  in) with retry, rate-limit and circuit-breaker policies; `@Budget`s per execution, tenant and
  application; cost accounting of every model call (#266, #261, #338).
- **Safety and quality** — PII policies masked at the model boundary, input and output guardrails
  decided by a model or by code, judges on an agent's answer as its DTO, memory compaction with
  built-in or custom strategies (#120, #262, #382, #383).
- **Testing** — `testWith(App)` with scripted models, the virtual clock, deterministic ids, class
  matchers, recorded runs and unit runners for every component kind (#262, #313); tool-call
  trajectories on results, records and `JudgeInput`, and one record per step (#395).
- **Eval suites** — `@EvalSuite` (`@agboss/core/eval`) with typed cases, trajectory checks and code or
  model judges under a declared cascade; `agboss eval run --suite <name> --runs <k> --report
<run.json>` runs each case k times on the application and reports pass@k / pass^k per case, the
  unstable ones flagged, into a run artifact (`agboss.eval-run`); `agboss check` assembles the suites;
  `--baseline <run.json> --fail-on-regression` compares each case with a run of `main` and exits 5
  (`quality`, `eval.regressed`) when a stable case regressed — a case flaky there is quarantined
  (#396). `--html <file>` and `agboss eval show <run.json> --html <file>` render a run as one
  self-contained HTML page — summary, unstable cases, attempt dots and every run's checks (#397);
  the artifact (`schemaVersion` 2) keeps each run's trajectory, masked, and the page shows it as a
  timeline, with the baseline diff and the node where an unstable case's attempts part ways;
  `agboss eval ui` serves a folder of runs on 127.0.0.1 behind a token, where people label a judge's
  verdicts into `eval/labels/<suite>.jsonl` and see κ recomputed, and save a run's kept execution
  (on its thread, of its tenant — each run's `tenantId`, `schemaVersion` 4) as a golden case of its suite — written into the suite's file, refused on a duplicate name or a
  file changed since the page was made (#397).
  `agboss eval calibrate --report <run.json>` reads a run's judges against people's labels
  (`eval/labels/<suite>.jsonl`) — Cohen's κ per labeler and between labelers, the confusion and the
  disagreements by the judge's metrics (#396).
  `agboss compare` judges each pair in both orders (a flip is a tie, `positionFlips`), and a
  judge of its agent's own model family warns `[judge.same-model-family]` (#396). Breaking on the
  way: `compareProfiles(Workflow, …)` is `compareProfiles(Application, { start, … })`.
  `agboss eval run --chaos <rate> --chaos-seed <n>` injects 429s, timeouts and truncated answers
  into the run's model calls (`ChaosFailure`; `eval run` only, never a `createApp` option) (#396).
  `agboss eval run --metamorphic` runs each case's `variants` (its last turn reworded) and checks
  they call the same tools with the same required calls — the check `metamorphic` (#396).
  `agboss generate eval-case <name> --from-execution <executionId>` drafts a case from a kept
  execution (#401's history) into its suite — the turn, the contexts, the thread's earlier turns,
  the calls it ran as `tools.required` — masked as kept, nothing run (#396).
  `agboss hub show <path…> [--html <file>]` reads many applications' describe snapshots, eval runs
  and exported executions into one mesh — the applications, the calls between them, each one's
  health from its files — and one self-contained page; no project, nothing runs (#401).
  Its page shows each execution tree that crosses applications, stitched from their exports by each
  receiver's `origin` (the calling execution and its call's idempotency key) — a receiver that
  exported nothing is a stub (#401).
  Its crystallization radar ranks the mesh's model steps by spend × stability — how often one
  input gets one decision — and names the candidates to turn into code; each step record gains its
  `decision` (`route:` / `launch:` / `variant:` / `answer:<hash>`) for it (#401).
  `agboss hub ui <path…>` serves the Hub on 127.0.0.1 behind a token — `eval ui`'s own server and
  rules, read-only — with a search of the kept executions and a JSON API (#401).
  Both draw each contract the snapshots declare as an edge consumer → producer, and list the
  problems `agboss check --federation` finds between them — the same check — with their blast
  radius, and who calls an application whose latest eval run lost pass^k (#401).
- **The CLI** (`@agboss/cli`) — `agboss create`, `agboss generate`, `agboss check`,
  `agboss describe`, `agboss dev`, `agboss studio`, `agboss chat` / `agboss run`, evaluations and
  comparisons (#268). Breaking on the way (#396): the bare `agboss eval` is now `agboss eval score`
  (`agboss eval` lists its subcommands `run` / `score` and exits 2).
- **Skills for coding agents** — `SKILL.md` and thirteen references shipped in the package and synced
  into a project by `agboss check` (#305), among them a step-by-step guide to migrating LangGraph
  code — state, edges, `Send`, `interrupt` — to AGBoss (#424).

## [0.0.1] - 2026-10-10

### Added

- A placeholder published to npm to reserve the `@agboss/core` and `@agboss/cli` names; it holds no framework code.

[Unreleased]: https://github.com/agbossjs/agboss/commits/main
[0.0.1]: https://www.npmjs.com/package/@agboss/core/v/0.0.1
