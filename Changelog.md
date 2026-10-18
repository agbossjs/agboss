# Changelog

Breaking changes and notable additions, newest first. The API reports
(`packages/agboss/api/*.api.md`) hold the exact public surface of each entry.

## Unreleased — environments and defaults (#261, PR 4)

- **Breaking — environments are typed object literals**: the contract is a plain class with declared
  fields only (`environments/app.environment.ts`), declared once in
  `@Application({ environment: AppEnvironment })`; each environment is
  `export const environment: AppEnvironment = { … }` in `environments/<name>.environment.ts`.
  `defineEnvironment`, `fromEnv`, `FromEnv`, `FromEnvOptions`, `EnvironmentValues`,
  `EnvironmentDefinition` and the `declare module "agboss" { interface Environment … }` contract are
  removed; `agboss check` writes `interface Environment extends AppEnvironment {}` into
  `.agboss/types.d.ts`, so `ENV` is typed by the contract ([Environments](Environments)).
- **New**: `env("X")`, `env.integer("X")`, `env.flag("X")` (each with `{ default }`), `secret("X")`
  and `Secret` (prints as `***` everywhere, `.reveal()` gives the value; a literal in a `Secret`
  field does not compile); `EnvironmentErrorCode` (`environment.not-found`,
  `environment.missing-variables`, `environment.invalid-value`, `environment.no-contract`). A missing
  variable fails the start as `DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`;
  `agboss check --env <name>` lists the variables it needs, marked value / secret.
- **Breaking — tests run on `test`**: `testWith(App)` loads `test.environment.ts` and fails without
  it (no fallback to `dev`); `testWith(App, { environment })` and `createApp(App, { environment })`
  are removed — name an environment with `env`. An application without `environment` has none:
  naming one fails, `ENV` fails with `[di.missing-environment]`.
- **New assembly rules**: `[environment.contract-value]` (a value in the contract),
  `[environment.missing-field]` (a listed framework implementation's field missing from the
  contract), `[guardrail.no-model]`.
- **The `defaults` cascade**: `@Application({ defaults })` → `@Workflow({ defaults })` → the
  component's own field, merged field by field, the most specific level wins
  ([Configuration](Configuration#the-defaults-cascade--application--workflow--component-261)).
  **Breaking**: guards take `defaults.guardrail.model` (new), never `defaults.router.model` — a guard
  with no model anywhere fails with `[guardrail.no-model]`. `[router.no-model]` now reads
  `… uses DecidedBy.Model but has no model — set model or defaults.router.model`. `agboss describe`
  shows each router's model and each agent's temperature / maxTokens / history with where it came
  from (`(own)`, `(<application or workflow>)`, `(built-in)`).
- `loadWorkflow`, `studioGraphOf`, `compareProfiles` and `workflowOf` from `agboss/testing` assemble a
  workflow in the application that lists it (its `*.application.ts` next to it or above): its
  providers and `defaults`.

## Unreleased — recovery and the graceful stop (#265, PR 2)

- **Recovery** ([Several instances → Recovery](Several-instances#recovery)): an execution's record
  is `ExecutionRecordStatus.Running` while its tree moves (new public enum, root entry: `Running`,
  `Answered`, `Guarded`, `Failed`, `Paused`); every instance looks for `running` roots at its start
  and every 30 s, takes the lease of one whose holder died or stopped and continues it from its
  last checkpoint (a resolved pause first) — only the interrupted step runs again. A root of another
  config is left to a compatible instance and logged once.
- **Breaking — `ExecutionRecordRepository`**: a new abstract `findByStatus(status, limit, after?)`
  (a page of the records with that status, oldest first). A record is now written when the run
  starts (`running`) and completed when it ends, instead of appended at the end.
- **Breaking — `WorkflowResumeEvent`** has a `reason: ResumeReason` (new public enum:
  `Answered` — `app.resume`; `Recovered` — recovery, `decision` only when it took one).
- **The graceful stop**: `app.close(options?)` stops the sweep, runs `onStop`, waits for the running
  executions up to the shutdown timeout — `@Application({ shutdownTimeout })`,
  `app.close({ timeout })` (`CloseOptions`), default `seconds(25)` — then interrupts them: the call
  rejects with `ApplicationStoppingError`, no `onError`, the lease released at once, the record
  left `running` for recovery ([App → app.close()](App#appcloseoptions)).
- **SIGTERM / SIGINT**: `createApp` calls `app.close()` on either (a second one interrupts at
  once); the listeners are removed when `close()` finishes, and the signal is raised again when
  nothing else listens. `testWith` never listens.

## Unreleased — the paths DSL revised: one value per `.returns`, `{ about }` in the flow, `historyOf` (#299)

- **Breaking — `.returns(value, options?)` names one value** (#272 S54): a DTO class, `optional(…)`,
  `listOf(…)` or `oneOf(…)`. Several values (a start's map of fields) are a chain,
  `.returns(CompanyDto).returns(optional(SearchRequestDto))`, in any order; `.returns(A, B)` does not
  compile (untyped code: `FlowSyntaxError`). `ReturnsStep` holds one `value`.
- **Breaking — a `oneOf` output is written before its switch**: `.returns(oneOf(A, B)).switch(…)`;
  a `.switch` without it, or with another `oneOf`, is `[flow.returns-mismatch]`.
- **Breaking — `about(TargetDto, shape)` is removed** (with `AboutWrapper`, `DeclaredOutput`):
  components declare a plain `output`; the flow says what a value is about —
  `.returns(CritiqueDto, { about: PlanDto })`, `{ about: [PlanDto, BudgetEstimateDto] }`, and for a
  `oneOf` on the case, `caseOf(ChangesRequestedDto, { about: OfferDraftDto })` (never on
  `.returns(oneOf(…))`). A value's `about` slots are kept on `ScopeValueRecord.about`.
  `{ about }` on a start's `.returns(…)` does not compile (`[io.about-on-start]` at assembly).
  `[io.ambiguous-cycle]` hints name the `.returns` / `caseOf` to write it on.
- **Breaking — no string tags** (#272 S56): `{ as: "before" }`, the tag slots, their labels
  (`DraftDto[before]#1`) and `[flow.unused-tag]` are removed. **New `historyOf(Dto, { limit })`** in
  `input` (root entry and `agboss/dto`; `HistoryOf<T>`, `HistoryWrapper`, `HistoryOptions`): the field
  is `{ current, previous }` — the current value and the earlier versions oldest first, at most
  `limit` — typed `HistoryOf<Produced<Dto, P>>` in `InputOf`, shown in the input message
  (`### draft, earlier versions (oldest first)`) and by `describe`. It needs a current `Dto` on every
  path (`[input.missing-on-path]`); the replaced versions are never `[input.outdated-on-path]`; a
  `limit` that is not a positive integer → `[input.history-limit]`.
- **`[io.ambiguous-about]`** now: a producer whose values are `{ about: T }` reading `T` in two or
  more fields (with `historyOf(T)` the answers are about its current value);
  **`[flow.ambiguous-field]`**: two fields of one node that read one slot.
- **Breaking — `listOf(oneOf(A, B))` is one slot** (#272 S53): the filtered `list:ADto` / `list:BDto`
  slots are gone; a `listOf(ADto)` field after such a step is `[input.missing-on-path]`.
- [Path scope](Path-scope), [Workflow](Workflow), [Components](Components),
  [Standard DTOs](Standard-DTOs).

## Unreleased — the shared contracts and the execution lease (#265, PR 1)

- **New infrastructure contracts** (root entry), each with a built-in in-memory default, listed only
  in `@Application({ providers })` and found by inheritance: `ExecutionLeaseRepository`
  (`acquire(tenantId, rootExecutionId, lease)`, `renew`, `release`; `ExecutionLease { tenantId,
  rootExecutionId, holderInstanceId, leaseEpoch, expiresAt }`), `ExecutionTreeRepository`
  (`saveIfAbsent(key, value)` / `findById(key)` inside an execution; an implementation provides
  `saveIfAbsentInTree`, `findByIdInTree`, `deleteAllInTree`) and `RateLimitRepository`
  (`acquire(key, maxSlots, lease)`, `renew`, `release`; `RateLimitLease`). There is no
  `ExecutionSlotRepository` ([Several instances](Several-instances)).
- **The execution lease** (Q58): `app.execute` and `app.resume` move a tree only while holding its
  lease (`seconds(30)`, renewed every 10 s and before every checkpoint write, released when the pass
  ends). An instance that lost it stops, and its call rejects with `ExecutionLeaseLostError`
  (`execution.lease-lost`) — no `.onError`, no `onError`, no failed record: the new holder continues.
- **Breaking — `PausedExecutionRepository`**: a paused run has a `status` (`PauseStatus.Pending` /
  `Resolved`) and, once resolved, its `decision`; a new abstract `resolveByThreadId(threadId,
  decision)` turns a pending pause to resolved atomically. A resume records its decision first
  (a second resume of the same pause → `NotPausedError`), then waits for the tree's lease; the holder
  takes decisions resolved meanwhile and the waiting call returns the tree's current output.
- **Tree keys** of `ExecutionTreeRepository` are removed when the tree finishes, fails or is
  cancelled; a pause keeps them.
- **Testing**: `testWith(App, { instances: 2 })` with the fixtures `apps` and `clock`;
  `clock.advance` takes `seconds(…)` too and returns a promise — **`await` it** (the framework's
  waits sleep on the test clock) ([Testing](Testing)).

## Unreleased — `@Application`, infrastructure, the test entry (#261, PR 2)

- **Breaking — `@Application` is the one entry**: `@Application({ name, version, workflows,
  providers, budgets })` (`name` ends with `-application`, the class with `Application`), and
  `createApp(App, { env })` / `testWith(App)` take it. `createApp(Workflow)` and `testWith(Workflow)`
  are removed — they do not compile (the generated `.agboss/types.d.ts` brands every workflow) and
  fail at run time naming the fix. `app.execute(Start, …)` runs the workflow of that start (any
  workflow of the application); `resume` / `cancel` find the workflow of the thread; `app.name` /
  `app.version` are the application's. Environments are found next to the application file
  ([App](App), [Testing](Testing)).
- **New assembly rules** (`GraphRuleError`, all at once): `[application.no-workflows]`,
  `[application.not-a-workflow]`, `[application.duplicate-workflow]`, `[application.ambiguous-start]`
  (one start in two workflows), `[graph.duplicate-node-name]` across workflows,
  `[budget.not-a-budget]`, `[di.infrastructure-in-workflow]`, `[name.kind-suffix]` on the
  application and on budgets.
- **Infrastructure**: `CostLedgerRepository`, `ExecutionRecordRepository`,
  `PausedExecutionRepository` (new, root entry) and LangGraph's `BaseCheckpointSaver` — listed only in
  `@Application({ providers })`, found by inheritance, each with a built-in in-memory default.
  **Breaking**: `createApp({ stores, pausedRuns })`, `AppStores`, `PausedRunRepository` and
  `createSqlitePausedRunRepository` are removed, and **nothing is written to the home folder any
  more**: execution records (Terns) and the spend ledger were SQLite / JSONL files under
  `~/.langgraph-agents/` (`TERN_DB`, `SPEND_LEDGER_DIR`) and are now in memory — gone on restart,
  so `agboss eval` / `replay` only see records of their own process until the SQLite
  implementations of #265 are listed ([App → Infrastructure](App#infrastructure)).
- **Budgets, declarative**: `@Budget({ name, scope, period?, workflow?, deps? })` on a class that
  `implements BudgetHandler` (`maxSpend(): Usd | Promise<Usd>`), `BudgetScope.Application | Tenant |
  Execution`, `BudgetPeriod.Day | Week | Month`, all listed in `@Application({ budgets })`
  (`config/budget.config.ts`). They are components (injectable, `mockOf`-able); the checks at run
  time come with #261 PR 5 — until then `settings().limits` caps the money ([FinOps](FinOps#budgets)).
- **Tests**: every framework fixture and test runs through an `@Application`; `app.ready()` builds
  the test's application for a test that executes nothing; each test runs on the infrastructure the
  application lists (else the in-memory defaults), new per test.
- **CLI (until #268)**: `agboss run` / `chat --workflow <file>` run the application that lists the
  workflow — exported by its module, or by a `*.application.ts` in its folder or a folder above it —
  at that workflow's text start. `agboss create` / `generate workflow` write the workflow's
  `*.application.ts` and `config/budget.config.ts`.

## Unreleased — one container per application instance (#261, PR 1)

- **Breaking — no scopes**: one container per application instance, one instance per class (a class
  listed by two workflows is one instance). The `scope` option of every DI decorator, the `Scope`
  type, the run-scoped container and `[di.scope-mismatch]` / `[di.run-scope-outside-run]` are gone
  (against #184). Components keep no state: read the execution from `ExecutionContext`, keep data that
  outlive a step in the graph state, caches in your own service over external storage
  ([Components → Components keep no state](Components#components-keep-no-state)).
- **Breaking — lint**: `agboss/no-component-state` replaces `agboss/no-run-state-in-singleton` —
  `this.x = …` outside the constructor of any component is an error.
- **Lifecycle hooks**: `OnInit` (new in the root entry), `OnStart`, `OnStop`, `OnDestroy` — `onInit`
  (dependencies first) → `onStart` at start, `app.close()` → `onStop` → the running executions awaited
  → `onDestroy` (dependants first). A failing `onInit` / `onStart` stops the start
  (`[di.hook-failed] <Component>.<hook> failed: …`); failing stop hooks are collected into one
  `AggregateError`. After `app.close()` `execute` / `resume` reject with the new `ApplicationStoppingError`
  (`app.stopping`, an `onRunRejected`); `cancel` still works.
  **Breaking**: `AfterAssemble` is removed, `OnDestroy` now runs once at shutdown, not per run
  ([App → Lifecycle hooks](App#lifecycle-hooks)).
- **Implementation by inheritance**: a dependency on a contract gets the one listed class that extends
  it; two → `[di.ambiguous-implementation]`. One token with different values →
  `[di.conflicting-values]`; `provide(Class, …)` → `[di.instance-provider]` (no `new`: the container
  creates every instance) ([Components](Components)).
- `createAppDeps(…).close(executionsDone?)` takes what to wait for between `onStop` and `onDestroy`.

## Unreleased — code routers (#280)

- **`DecidedBy.Code`**: a router decided by its class — `implements RouterHandler<Self>`,
  `route(input: InputOf<Self>)` returns one of its targets (`Route<Self>`, generated; a target outside
  `routes` does not compile); `deps` in the constructor like an action, the execution through
  `deps: [ExecutionContext]`. No model call, cost 0, the same flow as a model router
  ([Routers → Routers decided by code](Routers#routers-decided-by-code),
  [Routing patterns](Advanced-Routing)).
- **`@Router` options are a union by `decidedBy`** (`ModelRouterOptions` / `CodeRouterOptions`):
  `model`, `prompt`, `promptUrls`, `promptVariables` and route `prompt`s only on a model router;
  `deps` only on a code router.
- **`spawn` / `failure` on routes** (`SpawnPolicy.Always | OnDemand`, `FailurePolicy.FailFast | Skip`),
  both kinds — the options of a parallel launch (#273). Defaults `Always` + `FailFast`; a code
  router's route `OnDemand`. With `.chooseOne(…)` an explicit one → `[router.policy-with-choose-one]`
  and `Route<R>` is every target; before a launch `Route<R>` leaves `Always` targets out and every
  route `Always` → `[router.all-routes-always]`. The generated `RouterAnswers` table types what
  `route()` returns.
- **Breaking — router errors (S19)**: `RouterFailedError` (`step.router`, the original as `cause`: a
  model call or `route()` failed) and `RouterDecisionError` (`step.router.invalid-decision`, now a
  `RouterFailedError`: an answer outside the routes, a list after `.chooseOne(…)`, an unreadable
  answer — never retried). Both carry `component`, `nodeId`, `visitNumber`. The instance codes
  `router.failed` / `router.unknown-route`, the type `RouterFailureCode` and the field `router` are
  gone (`router` → `nodeId`); an unreadable model answer is now `RouterDecisionError`, not a failure.
  `.onError(RouterFailedError, …)` takes both; `.onError(DomainError, …)` the error inside.
- `agboss describe` lists code routers as `code`; `mockLlm(CodeRouter)` throws (a code router calls
  no model — `mockOf()` its services).

## Unreleased — one call per line in flow chains (#289)

- **Style**: a flow chain has one call per line — `start(A)` / `.returns(B)` / `.toFinish(C)`, and
  `route(X)` / `.toFinish(F)` inside a `chooseOne(…)` ([Workflows](Workflow) → The grammar). In the
  repo, `*.workflow.ts` modules and the flow fixtures are left out of Prettier (which joins short
  chains), formatted by `make fmt` and checked by ESLint's `@stylistic/newline-per-chained-call`;
  the docs' and Wiki's ts snippets that build paths are checked by `npm run check:docs`
  (`doc:line: … (@stylistic/newline-per-chained-call)`). `agboss create` / `agboss generate` write
  workflow modules one call per line.
## Unreleased — outdating at run time (#271)

- **`scope` holds current values only**: a write moves the older value of its slot and everything
  built from it to `outdatedValues`, each with `outdated: { byValueId, reason }` — `byValueId` the
  root trigger, `reason` an `OutdatedReason` (`Replaced`, `AboutReplaced`, `BuiltFromReplaced`)
  ([Path scope → At run time](Path-scope#at-run-time)). `OutdatedValueRecord.outdated` gains
  `reason`.
- **`onValuesOutdated`** (`OnValuesOutdated`, `ValuesOutdatedEvent`): one event per cascade, never
  empty, no DTO values; with `ExecutionEvent`'s fields (`executionId`, `parentExecutionId`,
  `rootExecutionId`, `threadId`, `workflow` as a `WorkflowRecord`) and `step` (a `StepRecord`)
  ([Observability](Observability#outdated-values)); one "values outdated" trace entry per cascade.
- **Records**: `WorkflowRecord`, `StepRecord`, `ScopeValueReference`, `OutdatedValueReference`,
  `OutdatedMark`; `WorkflowDescriptor`, `StepDescriptor` and `ComponentDescriptor` extend them.
- **`agboss describe`** prints each `about(…)` output ([CLI](CLI)).

## Unreleased — the execution context (#280)

- **`ExecutionContext`**: the one context of an execution, injected through the constructor —
  `deps: [ExecutionContext]`, a parameter named `executionContext` — into tools, actions, judges and
  services ([Context and Authorization](Context-And-Authorization)). Read-only data: `executionId`,
  `threadId`, `ownerId`, `signal`, `workflow`, `step` (`idempotencyKey` =
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, `callId`, `visitNumber`, …)
  and the tree (`parent`, `root`, `depth`, `executionOf(W)`). A read outside an execution or after
  its step ended throws `ExecutionContextUnavailableError` (`context.unavailable`).
- **No `ctx` parameter**: `ToolHandler.run(input)`, `@McpTool` alike; `ToolContext` and `RunContext`
  are gone (`ctx.run.runId` → `executionContext.executionId`, `ctx.run.owner` → `.ownerId`,
  `ctx.run.signal` / `ctx.signal` → `.signal`, `ctx.callId` → `.step.callId`, side effects key on
  `.step.idempotencyKey`). `ctx.run.metadata` and `ctx.run.input` have no replacement in the context:
  domain data come through a node's `input`. `ctx.pause(question)` is **removed until #267**
  (questions as part of the graph; S44) — approval of a tool call through `@Tool({ channel })` keeps
  working. `ctx.reportCost(usd)` → `deps: [SpendRecorder]`, `spendRecorder.record({ service, cost })`
  (S43), counted in the money limits; a tool's `ROUTER_FACTORY` decisions are accounted as its
  spend by the framework.
- **A tool call's signal** (S45): in a tool call `executionContext.signal` aborts on the execution's
  cancel and at the tool's own `timeoutMs`.
- **Judges**: `judge(input: JudgeInput)` (`reply`, `task`, `attempt`) instead of
  `judge(reply, ctx: JudgeContext)`; the judge's model through `deps: [JudgeModel]`
  (`judgeModel.invoke` / `judgeModel.decide`).
- **Testing**: `testExecutionContext({ … })` replaces `testRunContext()`; `toolOf(tool).invoke(input)`
  takes no context; `app.tool(T).invoke(input)` runs the tool in an execution of its own.
- An exported tool called over MCP runs in an execution of its own; the client's `_meta.callId` is
  its `step.callId`.

## Unreleased — the flow as paths (#272, #270, #269)

- **Outdating** (#271, [Path scope](Path-scope)): a field reads only current values — a new value
  outdates everything built from the older one, and assembly proves no node reads an outdated value
  (`[input.outdated-on-path]`). In a cycle of classes built from each other the component that
  answers says what about: `output: about(DraftDto, oneOf(ApprovalDto, DraftChangesDto))`
  (`[io.ambiguous-cycle]`, `[io.ambiguous-about]`). A review loop written without `about` no longer
  assembles; the hint names the output to wrap.

- **The flow is a list of paths** ([Workflow](Workflow), [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)):
  `start(S).returns(Dto).toRouter(R).chooseOne(route(A)…)`, `.toAgent` / `.toAction` / `.toFinish`,
  `.switch(caseOf(…))`, `.onError(E, <side path>)`; own paths `agent(X)…` / `router(R)…` /
  `action(A)…` for shared nodes. Removed: `from(…).next(…)`, `from(R).routes()`, `chain`, `node`,
  `catchError` / `compensateWith`, `nextParallel` / `join`, `batchParallel`, `joinQuorum`,
  `@QuorumRouter`, `parallel(…)` / `optional(…)` route targets, `Self`, nested `@Workflow` nodes,
  sagas and `compensate`, the `agboss/concurrency` entry. Parallel launches return in #273, child
  workflows in #263, code routers in #280.
- **Generated types**: `agboss check` writes `.agboss/types.d.ts` (git-ignored) — what types the
  paths, `InputOf<X>` / `OutputOf<X>` and `app.execute(Start, input)`. A generated project runs it on
  install (`npm run types`); `declare readonly input` on a start is no longer needed.
- **Typed data on paths** ([Path scope](Path-scope)): `@Agent` / `@Action` / `@Router` /
  `@WorkflowFinish` take `input` fields and `output` shapes; wrappers `listOf`, `oneOf`, `optional`,
  `variant`, `isVariant` (`agboss/dto`). Agents read an input message after static instructions and
  answer a structured `output` through answer tools; `{{item}}` and `{{input.…}}` in instructions are
  gone (`[prompt.input-in-instructions]`).
- **Names**: every component `name` ends with its kind (`main-router`, `scout-agent`,
  `chat-workflow-start`, `charge-action`, `job-scout-workflow`) and is unique in the application;
  DTO classes on paths end with `Dto` — the standard DTOs are renamed (`WorkflowStartText` →
  `WorkflowStartTextDto`, `Money` → `MoneyDto`, …, [Standard DTOs](Standard-DTOs)). LangGraph node ids
  are the names (no `<kind>.` prefix).
- `@WorkflowAction` → `@Action`, `execute(input)` with its fields from the path's scope
  (`ActionHandler<Self>`). `ctx.run`, `ctx.idempotencyKey` and `ctx.executionContext` are gone
  from actions — since #280 the execution comes through `deps: [ExecutionContext]` (above).
- **Limits**: `@Workflow({ maxSteps })` replaces `limits.perRun.steps`; `maxVisits` on routers and
  agents (`VisitsLimitExceededError`, catchable with `.onError`); money stays in `settings()`.
- **Results**: `ExecutionStatus.Finished | Paused`; `result.finish` is `{ name }`; `{ record: true }`
  adds the execution record. The thread's history keeps finished executions as
  `start <name>: <input>` / `finish <name>: <output>`.
- **Enums instead of strings** (#269): `Reasoning.…` instead of `thinking` strings on components,
  `RagMode.Tool | Context`, `ModelKind`, `ProviderSort`, `ImageDetail`, `ExecutionStatus`.
- `defaults.router` is `{ model }` (no `kind`); a `@Router` takes `decidedBy: DecidedBy.Model` and a
  required `input`.
- job-scout: one path per turn, names with their kinds, profiles and golden sets under
  `job-scout-workflow/` ([Example](Example)).
