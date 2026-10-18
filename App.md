# App — `@Application` and `createApp`

An **application** is the one point of the whole app (#261): it lists its workflows, its
infrastructure and its budgets, and is what `createApp` and `testWith` take — never a single
workflow (`createApp(Workflow)` / `testWith(Workflow)` do not compile). Built and started, it is
one container for the whole application (every component, DI), every workflow's graph (every
assembly rule — **all** violations at once, before any model call) and the components' `onInit` →
`onStart` hooks. The CLI (`agboss chat`, `agboss run`) and the tests ([Testing](Testing)) use the
same `app`.

<!--
```ts file=job-scout.workflow.ts
import { Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Agent({ name: "shortlist-agent", description: "Keeps the shortlist", prompt: "Keep the shortlist.", model: "moonshotai/kimi-k2.6" })
export class ShortlistAgent {}
@Workflow({
  name: "job-scout-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ShortlistAgent)
      .toFinish(ChatWorkflowFinish),
  ],
})
export class JobScout {}
```
-->

```ts file=job-scout.application.ts
// job-scout.application.ts — its environments/ folder is next to this file
import { Application, Budget, type BudgetHandler, BudgetPeriod, BudgetScope, EmptyEnvironment } from "agboss";
import { usd, type Usd } from "agboss/units";
import { JobScout } from "./job-scout.workflow.js";

// config/budget.config.ts in a project: the whole application, a tenant per day, every execution
@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution }) // the default of every workflow
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}

@Application({
  name: "job-scout-application", // ends with -application; the class with Application
  version: "1.0.0", // the release; each workflow's version is its behaviour version
  environment: EmptyEnvironment,
  workflows: [JobScout], // the top-level workflows
  providers: [], // infrastructure only here: none → the built-in in-memory defaults and model providers
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget], // FinOps → Budgets
})
export class JobScoutApplication {}
```

<!-- snippet-context
import { ChatWorkflowStart } from "./job-scout.workflow.js";
import { JobScoutApplication } from "./job-scout.application.js";
-->

```ts
import { ExecutionStatus, createApp } from "agboss";

// optional: { env: "staging", profile: "scout-low-thinking" }
const app = await createApp(JobScoutApplication);

const first = await app.execute(ChatWorkflowStart, { text: "save the first job" });
if (first.status === ExecutionStatus.Paused) {
  await app.resume(first.threadId, { approved: true, by: "dana" });
}
const next = await app.execute(
  ChatWorkflowStart,
  { text: "and the second" },
  { threadId: first.threadId },
);
console.log(next.output?.text, next.spend.totalUsd);

await app.close(); // onStop hooks, the running executions (up to the shutdown timeout), MCP, tracing
```

## The application's rules

Checked at assembly, all at once (`GraphRuleError`, stable codes): `name` ends with `-application`
and the class with `Application` (`[name.kind-suffix]`); it lists workflows
(`[application.no-workflows]`, `[application.not-a-workflow]`); workflow names are unique in the
application (`[application.duplicate-workflow]`), and so is every component name
(`[graph.duplicate-node-name]`); a start is the door of one workflow — one start in two workflows
→ `[application.ambiguous-start]`; every entry of `budgets` is a `@Budget` (`[budget.not-a-budget]`,
its name ends with `-budget`), every workflow has an execution budget — its own or the default — and
there is a tenant and an application budget (`[budget.execution-budget-required]`,
`[budget.duplicate-execution-budget]`, `[budget.duplicate-default-execution-budget]`,
`[budget.tenant-budget-required]`, `[budget.application-budget-required]`,
[FinOps](FinOps#assembly)); infrastructure — model providers too — is listed only in
`@Application({ providers })` (`[di.infrastructure-in-workflow]`); every model of every workflow
resolves to exactly one listed model provider by `serves` (`[model.unserved]`,
`[model.ambiguous-provider]`, #266, [Model providers](Model-providers#which-provider-serves-a-model)).

## Infrastructure

A framework contract with a built-in default, one per application. Registered **only** in
`@Application({ providers })` — a class that `extends` the contract, created by the container
(`@Injectable({ deps })`, never `new`); found by inheritance: none listed → the built-in default,
two → `[di.ambiguous-implementation]`. A service that needs one injects the contract
(`deps: [CostLedgerRepository]`) and gets the listed implementation.

| Contract                    | What it keeps                                                      | Built-in default |
| --------------------------- | ------------------------------------------------------------------ | ---------------- |
| `ExecutionRecordRepository` | threads and their owners, one record per execution (`completeIfStatus`: a compare-and-set status write), scores, config snapshots | in memory |
| `CostLedgerRepository`      | the budgets' counters per budget, scope key and period, and each budget's last `maxSpend()` (`findSpentByCounter`, `saveAll`, `findMaxSpendByAccount`, `saveMaxSpend`) | in memory        |
| `PausedExecutionRepository` | the paused execution of each thread (`findByThreadId`, `save`, `resolveByThreadId` — `Pending → Resolved` with its decision, atomic —, `deleteByThreadId`) | in memory |
| `BaseCheckpointSaver`       | LangGraph's checkpoints, taken as is (ecosystem savers plug in)    | `MemorySaver`    |
| `ExecutionLeaseRepository`  | one lease per execution tree: who moves it (`acquire`, `renew`, `release`, #265) | in memory |
| `ExecutionTreeRepository`   | the shared state of one request (`saveIfAbsent`, `findById` inside an execution; removed when the tree ends) | in memory |
| `RateLimitRepository`       | concurrency slots as leases (`acquire(key, maxSlots, lease)`, `renew`, `release`) — the model providers' limits (#266) | in memory |

**Model providers** (#266) are infrastructure too: `@ModelProvider` classes in the same
`providers` list — none listed → the built-in `OpenRouterModelProvider` + `DecisionsModelProvider`,
one listed → the list is complete. They are not created by the container and not injected; the
application's model gateway calls them ([Model providers](Model-providers#register-them-in-the-application)).

Nothing is written to the home folder: with the defaults, records, spend, pauses and leases live in
the instance and are gone after a restart. Each contract has a ready SQLite implementation, enabled
only by listing it (`SqliteExecutionRecordRepository`, `SqliteCostLedgerRepository`,
`SqlitePausedExecutionRepository`, `SqliteCheckpointSaver`, `SqliteExecutionLeaseRepository`,
`SqliteExecutionTreeRepository`, `SqliteRateLimitRepository` — one file, the environment's
`sqlitePath`, required only then: [Several instances → SQLite](Several-instances#sqlite--several-instances-on-one-machine));
your own `extends` the contract and goes in `@Application({ providers })`. A workflow run on its
own (`agboss eval` / `replay` / `golden`, `createAppDeps`) uses the infrastructure of the one
application that lists it.
Running more than one instance: [Several instances](Several-instances).

## At start: the log, the warnings, `describe`

`createApp` logs once, through the application's `Logger` ([Observability → The framework's
log](Observability#the-frameworks-log)): what started (application, version, environment, host,
process) and the worst case of one call of each start in counts — then the startup warnings,
`app.warnings`: a config changed without a version bump, and the assembly warnings
(`[application.in-memory-cost-ledger]`, `[application.in-memory-pauses]`; errors under
`agboss check --strict`). No `maxSpend()` is called and nothing per tenant is logged; `testWith`
logs none of it. Observers are listed in `@Application({ observers })` only
([Observability](Observability)).

`agboss describe --workflow <path>` shows the workflow's application: each infrastructure contract
with its implementation and why (`CostLedgerRepository → SqliteCostLedgerRepository (listed in
@Application providers)` / `(built-in default: none listed)`, the `Logger` and the `Clock`
included), the budgets by scope with their periods, the execution budget that caps the workflow (its
own or the default — when it is the root of `app.execute`; nested, it spends from its root's), the
observers and the assembly warnings; then its count limits (`maxSteps` set or default, each node's
`maxVisits`, the worst case of each start). `--json` gives the same as `application` and `limits`.

## `app.execute(Start, input, options?)`

- `Start` is a `@WorkflowStart` of any workflow of the application: the execution runs the
  workflow that start opens (else `NotAWorkflowStartError`); `input` is
  typed by the generated `.agboss/types.d.ts` (`agboss check`) and checked against the start's
  `input` before any call (`DtoValidationError`, the field named, never the value).
- Options: `threadId` continues a conversation (without it a new thread is created; its id is in
  the result). An id the tenant does not have yet creates that thread (#262 Q4): the caller's own,
  idempotent id — an order number, a ticket — keyed by `tenantId` + `threadId` (the same id in
  another tenant is another thread) and bound to `ownerId`; it is created only once the budgets
  pass, so a refused execution leaves nothing. An id that cannot be one (empty, over 200
  characters, a control character) is `InvalidThreadIdError` (`run.invalid-thread-id`, an
  `onExecutionRejected`). `ownerId` (a thread created with an owner rejects another one — `ThreadOwnerError`),
  `tenant` / `execution` (the typed values of the context levels), `signal`, `onStream` (token and
  tool-call events), `configurable` (extra LangGraph keys), `record`. There is no untyped
  `metadata` or `executionContext` option (#261 PR 6): channels, guardrails, MCP sessions and A2A
  calls read the typed contexts. See [Context and Authorization](Context-And-Authorization).
- Before the first step (#261 PR 5) each budget of the execution is read once (`maxSpend()`, in the
  execution's context) and checked: one exhausted refuses it with `BudgetExceededError`
  (`limit.budget`) and an `onExecutionRejected` — no record, no model call ([FinOps](FinOps#at-run-time)).

## The result — `ExecutionOutput`

| Field                                                                 | What it holds                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `thread`                                                              | the conversation id — pass it to the next `execute` or to `resume`                 |
| `status`                                                              | `ExecutionStatus.Finished` or `ExecutionStatus.Paused`                             |
| `finish`                                                              | the `@WorkflowFinish` the run reached, as `{ name }` (absent when paused)          |
| `output`                                                              | the finish's DTO — the business result only (`WorkflowFinishTextDto`: `{ text }`), typed by the finishes of the start's paths |
| `record`                                                              | with `execute(…, { record: true })`: the execution record (path scope, last error) |
| `pause`                                                               | what the run waits for — the tool call waiting for approval (`agent`, `tool`, `args`) |
| `path`                                                                | the flow nodes it visited, in order, by name                                       |
| `spend`                                                               | the `CostReport` of this run ([FinOps](FinOps))                                    |
| `runId`, `compacted`, `traceUrl`                                      | the run's id, what memory compacted, the trace                                     |

A run that fails (a limit, a router, an agent) and that no `.onError` takes throws an `AGBossError`
with a stable `code`; the Tern and the spend are recorded first.

## `app.resume(threadId, decision, { tenantId, ownerId })`

A resume finds what exists, so it takes keys and access only: the tenant by its id (omitted →
`"default"`) and the thread's `ownerId`; the execution runs on the context values it started with
([Context and Authorization](Context-And-Authorization#the-values-per-execution)).
Continues, in the workflow the thread belongs to, the paused run of the thread with a `ToolCallApprovalDecisionDto` (`approved`, `by`,
`reason?` — [Pause seam](Pause-seam)); same result shape. A thread without a paused run →
`NotPausedError`. A run paused under another workflow version or config is checked by the
workflow's `onIncompatibleResume` policy (`IncompatibleResumeError`).

A resume has two phases (#265, Q58): it records the decision — the pause goes `Pending → Resolved`
atomically, so a second resume of the same pause gets `NotPausedError` — then takes the tree's lease
and continues. While another call or instance moves the tree it waits, and returns the tree's
current output once the holder took its decision ([Several instances](Several-instances#the-execution-lease)).
Observers get `onExecutionResume` with `reason: ResumeReason.Answered` (`ResumeReason.Recovered`
when [recovery](Several-instances#recovery) continues a tree).

## `app.cancel(threadId, { tenantId, ownerId })`

Aborts a running run — it stops before its next model or tool call and `execute` rejects with
`ExecutionCancelledError` — or drops a paused one, whose `resume` then throws `NotPausedError`;
`{ cancelled }` is `false` when the thread had neither ([Cancellation and idempotency](Saga-And-Cancellation)).
A thread the tenant does not have is `UnknownThreadError` (#261: a thread's key is `tenantId` +
`threadId`).

## `app.close(options?)`

From the call on, no new execution is accepted: `execute` / `resume` reject with
`ApplicationStoppingError` (`app.stopping`) — nothing was cancelled, the request is refused before
an execution starts, so observers get `onExecutionRejected` (`operation: ExecutionOperation`,
`tenantId`, `code`, a message without input values); `cancel` still works. Then, in order (#265 S30 / S51):

1. the instance stops its own [recovery sweep](Several-instances#recovery);
2. `onStop` of the components;
3. it waits for the running executions of every workflow to finish or pause — up to the
   **shutdown timeout**: `@Application({ shutdownTimeout })`, overridden by
   `app.close({ timeout })`, default `seconds(25)` (under the usual 30 s grace period of a
   platform and the 30 s lease). When it passes, what still runs is **interrupted**: its call
   rejects with `ApplicationStoppingError`, without `.onError` or `onExecutionError` (it is no failure), the
   tree's lease is released at once and its record stays `running` — so another instance continues
   it from its last checkpoint without waiting for the lease to expire;
4. `onDestroy`, then MCP connections and tracing are closed.

Every hook runs; failures are collected into one `AggregateError`. Calling it again is fine — with
a shorter `timeout` it shortens the wait (`seconds(0)`: interrupt at once).

<!-- snippet-context
import type { App } from "agboss";
declare const app: App;
-->

```ts
import { seconds } from "agboss/units";

await app.close({ timeout: seconds(10) }); // what still runs after 10 s moves to another instance
```

**SIGTERM / SIGINT.** `createApp` listens for both and calls `app.close()` (a platform stopping the
instance, Ctrl+C); a second signal while it stops interrupts at once. The listeners are removed when
`close()` finishes, however it was called; when nothing else listens for the signal received, it is
then raised again, so the process ends as it would have without the app. `testWith` never listens.

## Lifecycle hooks

Four hooks, per application instance, for every component the container creates (services,
repositories, providers, tools, handlers, guardrails, observers) — `implements OnInit, OnStart,
OnStop, OnDestroy`, each optional (#261):

| Hook        | When                                                                                    | For                                               |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `onInit`    | the component is created, its dependencies injected and past their own `onInit`         | opening its own: a connection, a pool, a warm-up  |
| `onStart`   | every component is past `onInit`; the app is ready; no `execute` yet                    | what needs the whole app: a check, a log line     |
| `onStop`    | `app.close()` or SIGTERM: no new executions are accepted, running ones go on            | stop taking work, finish its own operations       |
| `onDestroy` | the running executions on this instance have finished, paused or been interrupted       | closing connections, releasing resources          |

<!-- snippet-context
import { Injectable, type OnDestroy, type OnInit, type OnStart, type OnStop } from "agboss";
interface Pool {
  ping(): Promise<void>;
  drain(): Promise<void>;
  end(): Promise<void>;
}
@Injectable()
export class PoolProvider {
  readonly pool: Pool = {
    ping: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
}
// @snippet
-->

```ts
@Injectable({ deps: [PoolProvider] })
export class JobIndexService implements OnInit, OnStart, OnStop, OnDestroy {
  constructor(private readonly poolProvider: PoolProvider) {}

  async onInit(): Promise<void> {
    await this.poolProvider.pool.ping(); // no database → the app does not start
  }

  onStart(): void {
    /* the whole app is ready */
  }

  async onStop(): Promise<void> {
    await this.poolProvider.pool.drain();
  }

  async onDestroy(): Promise<void> {
    await this.poolProvider.pool.end();
  }
}
```

- A failing `onInit` / `onStart` → the app does not start: `[di.hook-failed] JobIndexService.onInit
  failed: …` (the original as `cause`); the components already past `onInit` get `onDestroy`.
- A failing `onStop` / `onDestroy` → the other hooks still run; the failures are collected into one
  `AggregateError`.
- Values (`provide(TOKEN, value)`) and test mocks have no hooks. Per-execution work is an observer,
  not a hook. `AfterAssemble` and the run-scoped `OnDestroy` are gone (#261).

## Options

`createApp(Application, options)` takes the external parts; anything not given is the production
default. Infrastructure is not an option: it is listed in `@Application({ providers })`
(`createApp({ stores, pausedRuns })` is gone, #261).

| Option                    | Default                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `env`                     | `dev` — the environment file next to the application file ([Environments](Environments))                  |
| `processEnv`              | `process.env` (provider keys, the `env()` / `secret()` variables)                                         |
| `gateway`                 | the application's model providers (`@Application({ providers })`, #266) — the one model-call seam         |
| `transport`               | MCP stdio / streamable HTTP from the server's config                                                     |
| `connectMcp`              | connect every server, check its contract (fail fast)                                                     |
| `clock`                   | the system clock (the built-in ledger's UTC day, the records' times)                                     |
| `newThreadId`, `newRunId` | random UUIDs                                                                                             |
| `container`               | `overrides` (values instead of classes — test mocks), `onCreate`                                         |
| `profile`, `profileRoot`  | none ([Profiles and comparisons](Profiles-and-comparisons))                                              |

`agboss/testing` builds its apps with these: a scripted gateway, stubbed MCP servers, a test clock,
deterministic ids — on the infrastructure the application lists.
