# AGBoss

[![CI](https://github.com/agbossjs/agboss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/agbossjs/agboss/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/agbossjs/agboss/badges/coverage.json)](https://github.com/agbossjs/agboss/actions/workflows/ci.yml)

Typed agent workflows on LangGraph, in TypeScript. Agents, tools, MCP servers and knowledge bases
are **Angular-style components** — annotated classes, wired by a `@Workflow` module, dependencies
through the constructor, every link checked by the compiler. Routing and judging by decision models
(Jev, GPT-6 Luna Decisions, … — calibrated, exact cost),
FinOps on every call, Terns and evaluation, profiles and comparisons, tracing.

## Use it

```bash
npx -p agboss-cli agboss create my-agents   # alias agboss c — a project from a short questionnaire
cd my-agents && cp .env.example .env && npm run chat
npx agboss g tool refund --workflow src/my-agents/my-agents.workflow.ts --agent assistant
# one tool per OpenAPI 3 operation (DTOs, a client in services/, tests), wired into the agent
npx agboss g openapi pets --url ./pets.yaml --workflow src/my-agents/my-agents.workflow.ts --agent assistant
# any layout: targets come from the workflow module, tests go where vitest looks, files are
# prettier-formatted; a rerun refuses — --force regenerates the files and keeps the wiring in them
# (tools, rag, MCP, judges, routes, …); --force --reset starts them over without it
```

Or add it to a project and write the components yourself:

```bash
npm i agboss
npm i -D agboss-cli   # the CLI (`agboss`)
```

<!-- snippet-context
import { Tool, type ToolHandler } from "agboss";
import { Text } from "agboss/dto";
export class JobQuery {
  @Text({ prompt: "what to look for" })
  query!: string;
}
@Tool({ name: "greenhouse_jobs", description: "Finds jobs", input: JobQuery, output: JobQuery })
export class GreenhouseJobs implements ToolHandler<JobQuery, JobQuery> {
  run(input: JobQuery): Promise<JobQuery> {
    return Promise.resolve(input);
  }
}
-->

```ts file=src/agents/scout.agent.ts
// src/agents/scout.agent.ts — the prompt is a file next to the agent
import { Agent } from "agboss";

@Agent({
  name: "scout-agent",
  description: "Finds jobs",
  promptUrls: ["./scout.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  tools: [GreenhouseJobs],
})
export class ScoutAgent {}
```

<!-- snippet-context
import { Agent, DecidedBy, Injectable, Router, WorkflowFinish, WorkflowStart } from "agboss";
import { WorkflowFinishTextDto } from "agboss/dto";
import { ScoutAgent } from "./agents/scout.agent.js";
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Agent({ name: "profiler-agent", description: "Reads the resume", prompt: "Read the resume.", model: "moonshotai/kimi-k2.6" })
export class ProfilerAgent {}
@Router({
  name: "main-router",
  description: "Sends the message to the agent that answers it",
  decidedBy: DecidedBy.Model,
  prompt: "Pick the agent that answers the message.",
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "Reading the resume", target: ProfilerAgent },
    { prompt: "Finding jobs", target: ScoutAgent },
  ],
})
export class MainRouter {}
@Injectable()
export class JobFitJudge {}
-->

```ts file=src/job-scout.workflow.ts
// src/job-scout.workflow.ts — the paths, defaults and providers; money is the application's budgets
import { Workflow, route, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

@Workflow({
  name: "job-scout-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter) // picks one of its @Router({ routes })
      .chooseOne(
        route(ProfilerAgent)
          .toFinish(ChatWorkflowFinish),
        route(ScoutAgent)
          .toFinish(ChatWorkflowFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 8 },
    history: { limit: 5 },
  },
  providers: [JobFitJudge],
})
export class JobScout {}
```

The application is the one entry (#261): it lists the workflows, the infrastructure (a class that
`extends CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
LangGraph's `BaseCheckpointSaver` or one of the shared contracts of #265 — `ExecutionLeaseRepository`,
`ExecutionTreeRepository`, `RateLimitRepository`; none listed → the built-in in-memory ones, nothing
written to the home folder; the SQLite ones below), its **model providers** and every budget.
`createApp` and `testWith` take it, never a workflow.

Model providers are infrastructure too (#266): `@ModelProvider` classes listed in
`@Application({ providers })` — none listed → the built-in `OpenRouterModelProvider` (chat) and
`DecisionsModelProvider` (Jev and the other decision models); one listed → the list is complete,
the built-ins are not added next to it. A workflow and its components only name models; every model
of the application (agents, model routers, the default router, guards, compaction, judges) resolves
to exactly one listed provider by `serves` at assembly — none → `[model.unserved]`, two →
`[model.ambiguous-provider]` (one model through two providers = two model strings, each in one
`serves`). `agboss describe` prints `model: … → <provider>` for each, `agboss check --models` checks
every model of every workflow of the application against its provider:

A provider's **policies** are app-wide too: `retryPolicy` retries one call (attempts, exponential
backoff with jitter, `Retry-After` honoured — the only place backoff is set); `rateLimitPolicy`
(`RateLimitPolicy.of({ maxConcurrentCalls, perMinute: { calls, tokens }, balancing })`) is one limit
for the whole application — every execution, tenant, parallel branch and instance shares it through
`RateLimitRepository` — a call without room waits (its signal ends the wait, its timeout starts only
with the room), waiting tenants share free slots by `QueueBalancingStrategy` (`TenantRoundRobin` by
default, `TenantLeastInFlight`, `TenantWeighted` by `tenant.weight`, `Fifo`), and a 429 pauses the
provider's whole queue for `Retry-After` on every instance, then halves this instance's
concurrency and grows it back by one a minute; `circuitBreakerPolicy` stops calling a provider that
is down — its state in `RateLimitRepository` as well. Without `rateLimitPolicy` there is no limit:
set it per your provider plan. A provider's `name` ends with `-model-provider`; its key is a
`Secret` field of the application's environment (`apiKey: "openRouterApiKey"`):

```ts file=src/model-providers/openrouter.model-provider.ts
// src/model-providers/openrouter.model-provider.ts — job-scout's chat models, with its own request fields
import {
  ModelCost,
  ModelProvider,
  OpenRouterProvider,
  OPENROUTER_BASE_URL,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  TRANSIENT_FAILURES,
  type OpenRouterFields,
} from "agboss/models";
import { minutes, seconds } from "agboss/units";

@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — every chat model job-scout uses",
  serves: [/.*/], // its chat models; decision models go to DecisionsModelProvider (no chat there)
  baseUrl: OPENROUTER_BASE_URL,
  baseUrlField: "openRouterBaseUrl", // the environment may set another (a proxy, a stub)
  apiKey: "openRouterApiKey", // a Secret field of the application's environment
  timeout: minutes(2), // per attempt, from the moment it has room
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8, // the plan's limits, for every instance at once
    perMinute: { calls: 120 },
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class OpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = { provider: { ignore: ["Inceptron"] } };
}
```

```ts file=src/environments/app.environment.ts
// src/environments/app.environment.ts — the key both providers read; `test` leaves it out
import type { Secret } from "agboss";

export class AppEnvironment {
  openRouterApiKey?: Secret; // dev, prod: openRouterApiKey: secret("OPENROUTER_API_KEY")
  openRouterBaseUrl?: string; // env.optional("OPENROUTER_BASE_URL"): unset → the provider's baseUrl
}
```

```ts file=src/job-scout.application.ts
// src/job-scout.application.ts — what createApp(JobScoutApplication, { env }) and testWith run
import { Application, Budget, type BudgetHandler, BudgetPeriod, BudgetScope } from "agboss";
import { DecisionsModelProvider } from "agboss/models";
import { usd, type Usd } from "agboss/units";
import { AppEnvironment } from "./environments/app.environment.js";
import { JobScout } from "./job-scout.workflow.js";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";

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
  name: "job-scout-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [JobScout], // app.execute(ChatWorkflowStart, …) runs the workflow of that start
  providers: [OpenRouterModelProvider, DecisionsModelProvider], // every model resolves to one
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget], // checked before each step
})
export class JobScoutApplication {}
```

Every storage contract has a ready **SQLite** implementation (#265), enabled only by listing it:
`SqliteExecutionRecordRepository`, `SqliteCostLedgerRepository`, `SqlitePausedExecutionRepository`,
`SqliteCheckpointSaver`, `SqliteExecutionLeaseRepository`, `SqliteExecutionTreeRepository`,
`SqliteRateLimitRepository`. They share one file per application instance — `sqlitePath` of the
environment contract, required only when one is listed (else `[environment.missing-field]`
names it); WAL, `busy_timeout`, every atomic operation in `BEGIN IMMEDIATE`, time from the
framework's clock. With them `--thread`, `agboss eval` / `replay` / `golden` see what earlier
processes wrote, a pause survives a restart, and another instance on the file recovers a run
whose process died; tests run on `sqlitePath: ":memory:"`. One file serves one machine (Wiki →
Several-instances):

<!-- snippet-context
import { SqliteCheckpointSaver, SqliteExecutionLeaseRepository, SqliteExecutionRecordRepository, SqlitePausedExecutionRepository, env } from "agboss";
-->

```ts
// environments/app.environment.ts — the contract declares the file
export class StoreEnvironment {
  sqlitePath!: string; // required because SQLite implementations are listed
}

// environments/dev.environment.ts — a file of the project (git-ignored), or AGBOSS_SQLITE_PATH
export const environment: StoreEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: ".agboss/job-scout.sqlite" }),
};

// @Application({ …, environment: StoreEnvironment, providers: durableStores })
export const durableStores = [
  SqliteExecutionRecordRepository,
  SqlitePausedExecutionRepository,
  SqliteCheckpointSaver,
  SqliteExecutionLeaseRepository,
];
```

**Time is the application's `Clock`** (#262, infrastructure like the stores): every time the
framework reads (the ledger's day, records, leases) and every wait it makes (lease renewals,
recovery, the shutdown timeout, a tool's `timeoutMs`, model call timeouts, retry backoff,
`Retry-After` pauses) goes through it — the system's clock unless `@Application({ providers })`
lists a class that `extends Clock`. A component that needs the time injects it; `testWith` runs
every test on a `VirtualClock` (`agboss/testing`), moved by `await clock.advance(seconds(30))`
without real waiting. Direct time in the framework (`Date.now()`, `new Date()`, `setTimeout`, …)
fails lint (`agboss/no-direct-time`):

```ts
// services/reminder.service.ts — the time comes from the application's Clock, never Date.now()
import { Clock, Injectable } from "agboss";
import { seconds } from "agboss/units";

@Injectable({ deps: [Clock] })
export class ReminderService {
  constructor(private readonly clock: Clock) {}

  async remindLater(): Promise<Date> {
    await this.clock.sleep(seconds(30)); // in a test: await clock.advance(seconds(30))
    return this.clock.now();
  }
}
```

A rule needs no model: `@Router({ decidedBy: DecidedBy.Code, routes: [{ target: A }, { target: B }] })`
on a class that `implements RouterHandler<Self>` decides in `route(input)`, returning one of its
targets (`Route<Self>`) — no model call, cost 0, the same flow. Routes may carry the options of a
parallel launch (#273): `spawn` (stated on every route of a model router before a launch —
`SpawnPolicy.Always` or `SpawnPolicy.OnDemand`; `OnDemand` by default on a code router's) and
`failure` (`FailurePolicy.FailFast` by default)
([Wiki → Routers](https://github.com/agbossjs/agboss/wiki/Routers)).

Several steps at once are a **parallel launch** (#273): `.toParallelAgents(ResearcherAgent,
CriticAgent, CriticAgent, { maxConcurrency: 3 })` or `.toParallelActions(…)`, always followed by
`.join()` and the values the branches give — `.join().returns(ResearchDto).returns(listOf(CritiqueDto))`,
checked against the generated `JoinOutputs`; one agent after `.returns(listOf(CompanyDto))` runs once
per item (`{ maxItems }` required; a longer list is truncated, never an error — `result.launches`
says `{ items, taken }`). At most `maxConcurrency` branches run at once, a new one starting as
another ends; a failed branch cancels the others and the join takes `.onJoinError(E, …)`
([Wiki → Workflow](https://github.com/agbossjs/agboss/wiki/Workflow)).

Not every answer is always needed: a **quorum** (#279) counts them — `.joinQuorum({ min: 2, max: 3,
deadline: seconds(30) })` goes on with the counted answers, `.joinQuorumGroups(group(LegalAgent,
CriticAgent).priority(1).returns(…).toAgent(…), …)` with the first complete group (by priority),
each group on its own path. `@Arbiter` classes decide which answers count, attached with
`.acceptedBy(X)` before the quorum (a chain is an AND, `anyOf(A, B)` stops at the first that
accepts): by model, a criterion per agent; by code, one `@OnAnswer(Agent)` method per agent. A single
answer a quorum may leave out is `optional(XDto)` in `.returns(…)` — the compiler and `agboss check`
say so on the quorum. At run time the quorum is decided as answers arrive: once `max` answers are
counted (or a group has won, or the quorum can no longer be reached) the other branches are
cancelled; the deadline runs on the application's `Clock`; not reached → `QuorumNotReachedError`
into `.onJoinError(…)`; a failing arbiter is `ArbiterError`. `result.launches` and `onQuorumDecided`
show each answer as counted, rejected (and by which arbiter), surplus or cancelled, and the winning
group; `agboss generate arbiter` writes a code arbiter for a launch
([Wiki → Parallel](https://github.com/agbossjs/agboss/wiki/Parallel)).

A whole **workflow is a step** too (#263): `.toWorkflow(CompanyCheckWorkflow)` runs an ordinary
`@Workflow` of the application as a child — a component "start input → one of its finishes'
outputs", runnable and testable on its own. Its start is chosen by the class of what comes in (one
start, else the one taking the chain's current value; `[graph.no-matching-start]` /
`[graph.ambiguous-start]` otherwise), its scope starts with that input only, and its result is
branched by class — `.returns(oneOf(CompanyScoreDto, CompanyRejectedDto)).switch(caseOf(…)…)`, one
case per finish output class. `.toParallelWorkflows(CompanyCheckWorkflow, { maxConcurrency: 3,
maxItems: 50 })` runs one child per item, joined as `.join().returns(listOf(oneOf(…)))`; a child
reached from two places has its own path `workflow(W).onError(…).returns(oneOf(…)).switch(…)`.
At run time each child is an execution of its own — its id, steps and `maxSteps`, no history —
inside its parent's checkpoint and budgets; an uncaught failure of its own fails the parent's step
with `ChildExecutionFailedError`, and `result.children` holds the nested records
([Wiki → Workflow-as-a-step](https://github.com/agbossjs/agboss/wiki/Workflow-as-a-step)).

A workflow may **launch itself** (#264): `ThisWorkflow` stands for the enclosing workflow in
`.toWorkflow(ThisWorkflow)`, `route(ThisWorkflow)` or `.toParallelWorkflows(ThisWorkflow, { maxItems
})` — a topic too broad for one report researched subtopic by subtopic by the same workflow. A
recursive workflow sets `@Workflow({ maxDepth: 3 })` (`[graph.recursion-without-depth]`); the root is
at depth 1 (`executionContext.depth`, and each child record's `depth`), so the last level is
`depth === maxDepth`. There the framework stops it, never the prompt: an agent's `oneOf` variant
whose `caseOf(…)` launches `ThisWorkflow` leaves its response schema, a model router does not see such
a route, a code router returning one fails with `RouterDecisionError` — so every such branch keeps a
way out (`[graph.recursion-without-exit]`); a launch decided by code past `maxDepth` does not start
and fails its step with `ChildExecutionFailedError` caused by `DepthLimitExceededError`
(`.onError(LimitExceededError, …)` takes it). Only direct recursion: a workflow launching one that
launches it is `[graph.mutual-recursion]`. The root's execution budget counts every level; each
level has its own `maxSteps`; `agboss describe` prints `recursive: ThisWorkflow, maxDepth 3, on the
last level: researcher-agent → TopicReportDto only`. Each recursive workflow is typed by its own
entry: the `.returns(…)` after a `ThisWorkflow` launch is checked by `@Workflow({ name, flow })`
against the generated `ThisWorkflowOutputs[name]`, so one project holds recursive workflows with
different finishes.

The whole tree shares one **concurrency cap** (#264): `@Workflow({ maxConcurrentExecutions: 6 })` of
the root (default 10) — how many executions of the tree, the root and all its descendants, work on a
step at once. A step without a free slot waits in a queue — a throttle, never an error; an execution
waiting at a join, for its child or paused holds no slot (an execution's parallel branches share its
one). The queue serves a parent whose children have all finished first, then the deepest execution,
every 10 s of waiting counting as one level deeper (the application's `Clock`). A launch's
`maxConcurrency` and the cap both hold — the stricter wins; a child workflow's own smaller
`maxConcurrentExecutions` limits its subtree (a larger one is `[limits.child-concurrency-above-parent]`,
a warning). Time in the queue does not count toward a quorum's `deadline`. The slots are in-process
under the tree's lease: after a pause or a crash the next pass rebuilds the queue from the unfinished
tasks, and a `FailFast` failure empties it. A slot is an execution, not model load — provider
throughput is `rateLimitPolicy` ([Wiki → FinOps → Concurrency of a tree](https://github.com/agbossjs/agboss/wiki/FinOps#concurrency-of-a-tree-264)).

`npx agboss check --workflow src/job-scout.workflow.ts` writes `.agboss/types.d.ts` — what types
the paths, each node's input and `app.execute`; a generated project runs it on install
(`npm run types`).

The whole shape — DTOs, a service, a tool, an agent, a router, the workflow, its application and
its test — is the
worked example in [`CLAUDE.md`](CLAUDE.md) → Architecture (compiled and run by `make check`).

```bash
npx agboss chat --workflow src/job-scout.workflow.ts
npx agboss describe --workflow src/job-scout.workflow.ts   # agents, tools, dependencies — no API key
npx agboss --help                                          # run, eval, replay, golden, compare, rag:index
```

Needs `OPENROUTER_API_KEY` in `.env` (dev's `openRouterApiKey: secret("OPENROUTER_API_KEY")`). Docs: [Wiki → Components](https://github.com/agbossjs/agboss/wiki/Components) ·
[Configuration](https://github.com/agbossjs/agboss/wiki/Configuration) · [Knowledge bases](https://github.com/agbossjs/agboss/wiki/Knowledge-bases) ·
[Profiles and comparisons](https://github.com/agbossjs/agboss/wiki/Profiles-and-comparisons).

## The examples

[`examples/job-scout`](examples/job-scout) — resume → proposed search brief → Greenhouse jobs ranked
by Jev. It depends on `agboss` exactly like your project would:

```bash
npm install && npm run build          # at the repo root
cd examples/job-scout && npm run chat # "my resume src/data/sample-resume.md"
```

[`examples/flow-patterns`](examples/flow-patterns) — the flow's patterns with scripted tests only
(no model key): `src/offer/` a review loop (`agent(ReviewerAgent).returns(oneOf(…)).switch(…)`,
`caseOf(ChangesRequestedDto, { about: OfferDraftDto })`, `.onError(VisitsLimitExceededError, …)`), `src/credit/` a code
router (`DecidedBy.Code`, `route(input)` through `deps`) beside a model router, `src/review/`
parallel launches in waves (a reviewer per section, then a critic beside two fact checker copies),
`src/topic/` a workflow that researches its subtopics itself (`ThisWorkflow`, `maxDepth`, #264).
Point the CLI at it:

```bash
cd examples/flow-patterns && npx agboss describe --workflow src/offer/offer.workflow.ts
```

More: [Wiki → Example](https://github.com/agbossjs/agboss/wiki/Example).

## Public entries

One package; the root `agboss` is the authoring API, the rest are focused entries:

- `agboss` — `@Workflow`, `@Agent`, `@Router`, `@Tool`, `@Injectable`, `@Action`,
  `@WorkflowStart` / `@WorkflowFinish`, `@Judge`, `@Guardrail`, `@PiiPolicy`, `@Channel`,
  `InjectionToken`, `provide`, `env`, `secret`, `Secret`, the context levels (`ApplicationContext`,
  `TenantContext`, `ExecutionContext`, `ContextValues`), the path builder (`start`,
  `agent`, `router`, `action`, `route`, `caseOf`, `toAgent`, `toAction`, `toFinish`, …),
  `WorkflowSettings`, `@Application`, `createApp`, `@Budget`, the infrastructure contracts (`Clock`
  among them),
  `Decision`, observers, errors and types
- `agboss/dto` — field decorators (`@Text`, `@ListOf`, …), the DTO wrappers (`listOf`, `oneOf`,
  `optional`, `variant`) and the standard DTOs
- `agboss/units` — `usd()`, `seconds()`, `minutes()`
- `agboss/models` — model providers (`@ModelProvider`, listed in `@Application({ providers })`)
- `agboss/testing` — `testWith`, the scripts (`replyWith`, `routeTo`, `when`, `waitFor`, …), `ToolFailure`,
  `mcpOf`, `VirtualClock`, VCR (+ `agboss/testing/setup`: the matchers)
- `agboss/mcp`, `/rag`, `/a2a`, `/memory` — integrations (`@McpServer`, `@McpTool`,
  `@McpExpose`, `@Rag`, A2A, memory)

Importing `agboss` has no side effects: tracing, the MCP SDK and SQLite load only when an app
uses them. The old entries `agboss/core`, `/graph`, `/router`, `/tool` and `/channels` are
deprecated re-exports for one minor release (`/concurrency` went with the old flow DSL, #272); `agboss migrate imports` rewrites them
(and the renamed `Router` engine type → `RouterEngine`, root `McpServer` → `McpExpose` from
`agboss/mcp`, testing `Duration` → `ClockDuration`, `TestClock` → `VirtualClock`). Every entry's surface is in
`packages/agboss/api/*.api.md`; `npm run api:update` after an intended API change.

## Repository

```
packages/agboss/   the framework (published as `agboss`)
examples/job-scout/     the example (uses only the public API)
examples/flow-patterns/ the flow's patterns: a review loop, a code router, parallel launches (scripted tests only)
```

`make check` — build, API reports, compiled docs, format, lint, types, tests with coverage for both packages. `npm run dev` —
rebuild the framework on change. The framework never imports the examples, and the examples use
only `agboss` — both enforced by ESLint.

## Environments

One set per application, in `environments/` next to the application file (#261). The contract is a
plain class with declared fields only, declared once in the application:

<!-- snippet-context
import { Application, Workflow, WorkflowStart, start, WorkflowFinish } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { Budget, BudgetScope, BudgetPeriod, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";
@WorkflowStart({ name: "audit-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class AuditWorkflowStart {}
@WorkflowFinish({ name: "audit-workflow-finish", description: "The answer", output: WorkflowStartTextDto })
export class AuditWorkflowFinish {}
@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  flow: [
    start(AuditWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(AuditWorkflowFinish),
  ],
})
export class AuditWorkflow {}
@Budget({ name: "audit-execution-budget", scope: BudgetScope.Execution })
export class AuditExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
@Budget({ name: "audit-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class AuditTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}
@Budget({ name: "audit-application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class AuditApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}
// @snippet
-->

```ts file=src/audit/audit.application.ts
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  name: "audit-application",
  version: "1.0.0",
  environment: AppEnvironment, // the contract: environments/app.environment.ts
  workflows: [AuditWorkflow],
  budgets: [AuditApplicationDailyBudget, AuditTenantDailyBudget, AuditExecutionBudget],
})
export class AuditApplication {}
```

```ts file=src/audit/environments/app.environment.ts
// environments/app.environment.ts — the contract: fields only, no values
import type { Secret } from "agboss";

export class AppEnvironment {
  auditUrl!: string;
  databaseUrl!: Secret;
  port!: number;
  debug!: boolean;
}
```

Each environment is a plain object typed by the contract, in `<name>.environment.ts` — the file name
is the environment's name (`--env prod` → `prod.environment.ts`):

```ts file=src/audit/environments/prod.environment.ts
import { env, secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: env("AUDIT_URL"), // a process variable, read when the app starts
  databaseUrl: secret("DATABASE_URL"), // a Secret: only from a process variable, no default
  port: env.integer("PORT", { default: 8080 }),
  debug: env.flag("DEBUG", { default: false }),
};
```

```ts file=src/audit/environments/dev.environment.ts
import { secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: "http://localhost:4000", // a value in the file
  databaseUrl: secret("DATABASE_URL"), // `.env`: e.g. pglite://memory — dev without Docker
  port: 8080,
  debug: true,
};
```

- A field missing in an environment, a mistyped one or one the contract lacks does not compile; a
  literal in a `Secret` field does not compile either, and a `Secret` is not a `string`. A value in
  the contract (`auditUrl: string = "…"` — the environments are object literals, it would be
  ignored) fails assembly: `[environment.contract-value] AppEnvironment.auditUrl has a value — the
contract declares fields only; put the value in each environment`. A framework implementation
  listed in `providers` whose field the contract lacks fails with `[environment.missing-field]`.
- There are no wrappers: no `declare module`, no `export default`, no `defineEnvironment` /
  `fromEnv`. `agboss check` writes `interface Environment extends AppEnvironment {}` into
  `.agboss/types.d.ts`, so components read the values as `applicationContext.environment`
  (`deps: [ApplicationContext]`, #261 — no separate token), typed by the contract — never
  `process.env`; the chosen environment's name is `applicationContext.environmentName`:

```ts file=src/audit/services/audit-store.service.ts
import { ApplicationContext, Injectable } from "agboss";

@Injectable({ deps: [ApplicationContext] })
export class AuditStoreService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  connectionString(): string {
    return this.applicationContext.environment.databaseUrl.reveal(); // the only way to the value
  }
}
```

- A `Secret` prints as `***` everywhere it could be printed — logs, traces, JSON, `agboss describe`,
  error messages; only `.reveal()` gives the value. Secrets are process variables and only that: in
  Cloud Run a Secret Manager secret is bound to the variable at deploy
  (`--set-secrets=DATABASE_URL=database-url:3`); the framework calls no cloud SDK.
- `agboss chat --workflow src/app.workflow.ts` (the application that lists it) loads `dev`;
  `--env staging` loads `staging.environment.ts` (every workflow command takes `--env`). An unknown
  name fails at once (exit 3) listing the available ones; a variable without a value or default fails
  the start naming it, the field and the environment, never the value:
  `DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`. `agboss check` validates the selected
  environment without running anything, creating every component the start creates, so it fails
  exactly when the start would; `agboss check --env prod` lists the process variables it needs,
  marked value / secret; `agboss describe` shows the environment with secrets masked.
- From code: `createApp(Application, { env: "staging" })`. Tests run on `test`:
  `testWith(Application)` loads `test.environment.ts` and fails without it (a test never reaches
  dev's addresses by accident); `testWith(Application, { env: "dev" })` names another.
- Dev / prod parity (12-factor): the same `providers` — the same implementations and code — in
  every environment; only values differ.
- `environment` is required: an application with no settings declares the framework's empty
  contract, `@Application({ environment: EmptyEnvironment })` (any contract without fields works the
  same), and needs no environment file — its `dev` and `test` are `{}`. (An untyped caller without one gets an empty environment.)
- Model provider keys are part of it (#266): each `@ModelProvider` names the `Secret` field that
  holds its key (`apiKey: "openRouterApiKey"`; the built-ins read `openRouterApiKey`), set with
  `openRouterApiKey: secret("OPENROUTER_API_KEY")` in each environment that calls models — a test
  environment may leave it out (tests script or replay models). A missing key fails the start of an
  app that calls the provider; `agboss check` (without `--models`) reads the contract's shape and
  writes the types without one. A base URL is read the same way: `baseUrlField:
"openRouterBaseUrl"` with `openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")` — no `{ default }`:
  unset, it is `undefined` and the provider uses its decorator's `baseUrl` (#266 S87).
- `env.optional("X")` (`env.integer.optional`, `env.flag.optional`) reads a variable that may be
  unset — `undefined` then, for an optional field of the contract (`x?: string`); a set value is
  still checked, and `agboss check --env` marks it `(optional)` (#266 S90).

## Quality gates (judges)

`@Agent({ judges: [AnswerGroundedJudge], maxRetries: 1 })` runs every judge on the agent's reply. A
judge is a `@Judge({ name, model, reply, deps })` class implementing `JudgeHandler<TReply>`; the
container creates it with its `deps`, and its **own** model is called through the model gateway, so
its spend is in the run's cost report (`judge:<name>`, category `review`). A judge sees the agent's
answer **as its DTO** (#262 S115): `reply` names what it judges — a DTO class, `oneOf(A, B)` (the
reply is `A | B`) or `PlainTextDto` for a text agent (`{ text }`) — and `judge({ reply, task,
attempt })` gets the validated answer object, never a serialized string. An agent whose `output`
its judge does not judge fails assembly with `[judge.wrong-reply]`: a text agent with a DTO judge, a
DTO agent with another class, a `oneOf` variant the judge does not cover, a list output (a judge
sees one answer). A verdict is built with `JudgeVerdict.passed({ metrics? })` or
`JudgeVerdict.failed({ reason, metrics? })` — the only way; a failed verdict's `reason` goes back to
the agent for its retry, and once `maxRetries` retries are spent the run throws `QualityGateError`
(`code: "step.agent.quality-gate"`, `rejections: [{ judge, reason }]`). A judge without a model
fails at app start (`[judge.no-model]`).

A judge's model comes through the constructor (`deps: [JudgeModel]`): a chat model
(`judgeModel.invoke(...)`) or a **decision model** (`judgeModel.decide({ state, questions })`) —
every model of OpenRouter's Decisions API:
`typesafe/jev-1.13`, `openai/gpt-6-luna-decisions`, `perplexity/pplx-decider-v1(.1)-27b`,
`cloudflare/clef(-flash|-omni)`, `upstage/solar-decide`, `inception/mercury-decide`
(`DECISION_MODELS`; `DecisionsModelProvider` serves them, `JevModelProvider` is its deprecated alias).
Questions come from `Decision.noul` (yes/no → `noul` = P(yes)), `Decision.choice` (→ `choice`,
`probabilities`, `confidence`) and `Decision.score` (levels lowest first → `score` = the level's index);
the answers are typed by them. `state` is a text, a JSON object, or text and image parts
(`Decision.image(dataUrl)` — png/jpeg/webp data URLs; Luna, pplx-decider and Clef read images). At
most 200 questions per call; an answer that does not fit its question fails with
`model.decision.invalid-response`. `decide` on a chat model or `invoke` on a decision model throws
`ModelKindError` (`model.wrong-kind`).

<!-- snippet-context
import { InjectionToken } from "agboss";
import { ListOf, Text } from "agboss/dto";
export class JobDto {
  @Text({ prompt: "the job's title" })
  title!: string;

  @Text({ prompt: "where the job is posted" })
  url!: string;
}
export class JobReportDto {
  @ListOf(JobDto, { prompt: "the jobs found" })
  jobs!: JobDto[];
}
interface JobSearch {
  exists(url: string): Promise<boolean>;
  lastResults(): readonly string[];
}
const JOB_SEARCH = new InjectionToken<JobSearch>("JOB_SEARCH");
-->

```ts
import {
  Decision,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "agboss";

@Judge({
  name: "answer-grounded-judge",
  model: "openai/gpt-6-luna-decisions",
  reply: JobReportDto, // what it judges: the agent's output, as its DTO
  deps: [JudgeModel, JOB_SEARCH],
})
export class AnswerGroundedJudge implements JudgeHandler<JobReportDto> {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly jobSearch: JobSearch,
  ) {}

  async judge({ reply, task }: JudgeInput<JobReportDto>): Promise<JudgeVerdict> {
    const [first] = reply.jobs;
    if (first === undefined || !(await this.jobSearch.exists(first.url))) {
      return JudgeVerdict.failed({ reason: "the first job does not exist" });
    }
    const a = await this.judgeModel.decide({
      state: { task, jobs: reply.jobs.map((job) => job.title), results: this.jobSearch.lastResults() },
      questions: {
        grounded: Decision.noul("Every job of the report appears in the results"),
        tone: Decision.choice("Tone of the report", {
          neutral: "Plain, factual",
          pushy: "Sells or pressures",
        }),
        quality: Decision.score("Overall usefulness", ["useless", "partial", "complete"]),
      },
    });
    // a.grounded.noul: number; a.tone.choice: "neutral" | "pushy"; a.quality.score: number
    return a.grounded.noul > 0.7 && a.tone.choice === "neutral"
      ? JudgeVerdict.passed({ metrics: { quality: a.quality.score } })
      : JudgeVerdict.failed({ reason: "Only report jobs from the search results, neutrally." });
  }
}
```

In tests, script a chat judge like an agent — `mockLlm(Judge).thenReturn(replyWith("PASS"))` — and a
decision judge with its answers by question id (an option, P(yes), a level's index or text):
`mockLlm(AnswerGroundedJudge).thenReturn(decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }, { cost: usd(0.0002) }))`;
on its own, `testJudge(AnswerGroundedJudge, …)({ reply, task, attempt })` takes `reply` as a plain
object of its DTO, typed by the judge (another shape does not compile).

Routers and guards work on any decision model too (`@Router({ model: "openai/gpt-6-luna-decisions" })`):
one choice question over the routes, options sorted so declaration order never changes the request.

## Testing

`testWith(Application)` (`agboss/testing`) runs the whole application in each test — its real
container and infrastructure, models by script, MCP servers stubbed, the network blocked, a
`VirtualClock`. Scripts are typed by the generated `.agboss/types.d.ts` (`agboss check`, #262):
`replyWith(XDto, fields)` must be a class of the agent's output (a class outside its `oneOf` does
not compile), `routeTo(…)` a target of the router's routes — exactly one after `.chooseOne(…)`, the
`OnDemand` targets it launches before `.toParallelAgents(…)` (`routeTo()` only with an `Always`
route). `when(…)` binds turns to the node's input values, at any depth: a deep partial of each
field's `value` (the producer is not compared), `undefined` for an absent field, a `listOf` field by
length and position, a `oneOf` element as `variant(XDto, { … })`; a call no script matches fails the
test, naming its input. A script is an expectation: a `thenReturn` turn no call took, or a `when(…)`
nothing matched, fails a test whose body passed (`thenReturnAlways` never does).
`waitFor(seconds(31))` before a turn makes the call take that long on the test's clock.

<!-- snippet-context
import { ExecutionCancelledError } from "agboss";
import { Text } from "agboss/dto";
export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}
export class DraftApprovedDto {}
declare class OfferApplication {}
declare class OfferWorkflowStart {}
declare class ReviewerAgent {}
declare class EditorAgent {}
declare class SendOfferAction {}
declare class SearchJobsTool {}
declare class MailerService {
  send(text: string): Promise<void>;
}
// the start's input, typed by the generated types of a real project
declare const shortlist: never;
-->

```ts
import { expect } from "vitest";
import { replyWith, testWith, ToolFailure, waitFor } from "agboss/testing";
import { seconds, usd } from "agboss/units";

const test = testWith(OfferApplication);

test("the reviewer asks for changes once, then approves", async ({ app, mockLlm, mockAction }) => {
  mockLlm(ReviewerAgent)
    .when({ draft: { text: "v1" } })
    .thenReturn(replyWith(ChangesRequestedDto, { notes: "shorter" }));
  mockLlm(ReviewerAgent)
    .when({ draft: { text: "v2" } })
    .thenReturn(waitFor(seconds(1)), replyWith(DraftApprovedDto, {}, { cost: usd(0.01) }));
  mockLlm(EditorAgent).thenReturn(replyWith("v2"));

  await app.execute(OfferWorkflowStart, shortlist);

  expect(mockLlm(ReviewerAgent)).toHaveBeenCalledTimes(2);
  expect(mockLlm(ReviewerAgent)).toHaveReturned(ChangesRequestedDto, { notes: "shorter" });
  expect(mockAction(SendOfferAction)).toHaveBeenCalledWith({ draft: { text: "v2" } });
});

test("a cancel from inside a mock cancels the execution", async ({ app, mockOf, mockTool }) => {
  mockTool(SearchJobsTool).thenFail(ToolFailure.Timeout); // the next call fails as a timeout would
  mockOf(MailerService).send.mockImplementation(() => app.cancel("thread-1").then(() => undefined));

  await expect(app.execute(OfferWorkflowStart, shortlist)).rejects.toFailWith(
    ExecutionCancelledError,
  );
});
```

Calls are checked with Vitest's names on `mockLlm(X)` and `mockAction(A)` (the action still runs):
`.inputs`, `toHaveBeenCalledWith(…)` (the matcher of `when`), `toHaveBeenCalledTimes(n)` (model
calls; an action's executions), `toHaveReturned(XDto, fields?)`; on anything else — a `vi.fn()`, a
`mockOf(…)` method — they are Vitest's own. `toHaveBeenAskedWith` checks the prompt itself. Errors
are caused the real way — `failWith(ModelFailure.…)`, a rejecting `mockOf(…)`,
`mockTool(Tool).thenFail(ToolFailure.Timeout)`, scripts that reach a limit, `app.cancel` — and
matched with `rejects.toFailWith(ErrorClass, { …fields, cause: CauseClass })` through the cause
chain; the testing API has no way to create a framework error.

Parallel branches run one at a time in a test, in listed / item order (`TestConcurrency.Sequential`,
the default); `TestConcurrency.Real` runs them as production does, and
`TestConcurrency.inOrder([step(A), step(B)])` makes them complete in that order — a race, a
`FailFast` or a quorum gives the same result on every run. One component is tested on its own with
a unit runner: `testTool`, `testAction`, `testRouter`, `testArbiter`, `testRag`, `testJudge`,
`testGuardrail`, `testPii` — its own container (`overrides` replace classes by classes), the
`environment`, the frame of its step (`executionContext.signal` with a `timeout`, `SpendRecorder`),
its model by script; each call gives `{ output, spend }`.

<!-- snippet-context
import { Injectable, type JudgeHandler, type JudgeInput, type JudgeVerdict } from "agboss";
import type { PlainTextDto } from "agboss/dto";
declare class QuickPanelApplication {}
declare class PanelWorkflowStart {}
declare class SkillsAgent {}
declare class RisksAgent {}
@Injectable()
export class JobBoardService {
  search(query: string): Promise<readonly string[]> {
    return Promise.resolve([query]);
  }
}
@Injectable()
export class FakeJobBoardService extends JobBoardService {}
declare class SearchJobsTool {
  run(input: { readonly query: string }): Promise<{ readonly jobs: string }>;
}
declare class GroundedJudge implements JudgeHandler<PlainTextDto> {
  judge(input: JudgeInput<PlainTextDto>): Promise<JudgeVerdict>;
}
// the start's input, typed by the generated types of a real project
declare const candidate: never;
-->

```ts
import { expect, it } from "vitest";
import {
  decideWith,
  override,
  step,
  TestConcurrency,
  testJudge,
  testTool,
  testWith,
} from "agboss/testing";
import { seconds } from "agboss/units";

// the risks agent answers first, then the skills agent: the quorum counts them in that order
const test = testWith(QuickPanelApplication, {
  concurrency: TestConcurrency.inOrder([step(RisksAgent), step(SkillsAgent)]),
});

test("the first two answers are counted", async ({ app }) => {
  const result = await app.execute(PanelWorkflowStart, candidate);
  expect(result.launches[0]?.isQuorumReached).toBe(true);
});

it("searches the board it is given", async () => {
  const runSearch = testTool(SearchJobsTool, {
    overrides: [override(JobBoardService, FakeJobBoardService)],
  });

  const { output, spend } = await runSearch({ query: "TS" }, { timeout: seconds(1) });

  expect(output.jobs).toContain("TS");
  expect(spend.totalUsd).toBe(0);
});

it("a grounded reply passes", async () => {
  const runJudge = testJudge(GroundedJudge, { model: decideWith({ grounded: 0.9 }) });

  const reply = { text: "Acme hires TS engineers [acme.example]" }; // a PlainTextDto, as an object
  const { output } = await runJudge({ task: "Find TS jobs", reply, attempt: 0 });

  expect(output.passed).toBe(true);
});
```

## Execution Context & Observers

Every component reads the execution it runs in through its constructor (#280):
`deps: [ExecutionContext]`, a parameter named `executionContext` — tools, actions, judges and
services alike; there is no `ctx` parameter. It is data only and read-only, and every read gives the
current execution and step (one frame per node visit and per tool call), so it is safe in an
component (one instance for the app) and in parallel branches. One execution has one id: its observer events
(`event.executionId`), `executionContext.executionId`, its Tern (`Tern.runId`), its trace and its result
(`ExecutionOutput.runId`) carry the same one, also after a resume. What a node reads comes in its
input — for a model, its input message (each `input` field as `### field (from producer)`), never
through `{{input.…}}` in its instructions (`[prompt.input-in-instructions]`); the context carries no
input and no metadata.

<!-- snippet-context
import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { Text } from "agboss/dto";
export class OrderQuery {
  @Text({ prompt: "the order id" })
  orderId!: string;
}
@Tool({
  name: "pay_order",
  description: "Pays the order",
  input: OrderQuery,
  output: OrderQuery,
  deps: [ExecutionContext],
})
export class PayOrder implements ToolHandler<OrderQuery, OrderQuery> {
  constructor(private readonly executionContext: ExecutionContext) {}
// @snippet
}
-->

```ts
run(query: OrderQuery): Promise<OrderQuery> {
  const { executionContext } = this;
  executionContext.executionId; // unique per execution, the same after a resume (= ExecutionOutput.runId)
  executionContext.threadId; // the conversation (ExecutionOutput.threadId)
  executionContext.ownerId; // from execute(…, { ownerId }): who the thread belongs to
  executionContext.tenant.tenantId; // the organization, "default" when none is passed
  executionContext.tenant.application.environmentName; // the application level, through the tenant
  executionContext.signal; // aborted by app.cancel(threadId) or the caller's signal
  executionContext.workflow; // { type, name, version, startedVersion }
  executionContext.step.idempotencyKey; // `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`
  executionContext.step.callId; // the tool call's id (undefined outside a tool call)
  return Promise.resolve(query);
}
```

Read outside an execution (in a constructor at start) or after its step ended (a forgotten promise),
the context throws `ExecutionContextUnavailableError` (`context.unavailable`) — never `undefined`.

<!-- snippet-context
import type { App } from "agboss";
import { ChatWorkflowStart } from "./src/job-scout.workflow.js";
declare const app: App;
declare const threadId: string;
declare const userId: string;
declare const signal: AbortSignal;
-->

```ts
await app.execute(
  ChatWorkflowStart,
  { text: "Find me a backend job" },
  { threadId, ownerId: userId, signal, tenant: { tenantId: "acme" } },
);
const { cancelled } = await app.cancel(threadId, { tenantId: "acme", ownerId: userId });
```

A thread created with an `ownerId` belongs to it: `execute` on that thread, `resume` and `cancel`
with another owner (or none) throw `ThreadOwnerError` (`run.thread-owner`) before anything runs or
is read. A thread belongs to its tenant too (#261): its key is `tenantId` + `threadId`, so another
tenant's thread does not exist for the caller. `execute` with a `threadId` the tenant does not have
yet creates that thread — the caller's own, idempotent id (an order number, a ticket), bound to its
`ownerId`; the same id in another tenant is another thread (#262 Q4). An id that cannot be one
(empty, over 200 characters, a control character) is `InvalidThreadIdError`
(`run.invalid-thread-id`); `cancel` of a thread the tenant does not have is `UnknownThreadError`.
`resume` and `cancel` take the tenant by its id (omitted → `"default"`), and a resumed execution
runs on the context values it started with. With nothing declared `tenant: { tenantId?, weight? }` is
all there is (`weight`, a positive integer, default 1, is the tenant's share for #266's
`TenantWeighted`); an application that declares
`@Application({ tenantContext: ShopTenantContext, executionContext: ShopExecutionContext })` — its
own subclasses with DTO field decorators, identity only, never secrets — gets their values typed
per start (`tenant: ContextValues<ShopTenantContext>`, `execution: …`), checked before the first
step (invalid → `dto.invalid`, an `onExecutionRejected`, the field named, never the value) and frozen. Tool arguments a channel shows (and `ExecutionOutput.pending[i].ask.arguments`) have the input DTO's
`sensitive` fields through their action (`replacePart` as written, a token or a kind as `<field>`,
#120); the tool itself still gets them whole.

**Pauses (#267).** An execution may wait for several answers at once — one per tool call whose
channel replied `ChannelOutcome.awaitReply()`, in parallel branches too: a paused branch does not
stop its siblings, the execution pauses only when nothing else can move, and `result.pending`
lists every waiting pause (`PendingPause`: `answeredBy`, `agent`, `channel`, `itemIndex`,
`childExecutionId`, the question `ask`). A pause is answered by its id, never by its thread —
`app.resume({ pauseId, decision }, options)` — found by `(tenantId, pauseId)` anywhere in the tree
(unknown, or another tenant's → `UnknownPauseError`, `pause.unknown`); with other pauses left the
execution pauses again with the rest; the result carries `threadId` and `runId`. Who may answer is
the pause's channel role's `answeredBy`: a `PauseAnswerer.ThreadOwner` pause lists its `pauseId` in
`result.pending` and is resumed with the thread's `ownerId` (another → `ThreadOwnerError`); a
`PauseAnswerer.Channel` pause's id is the right to answer it — only its channel got it
(`ask.pauseId`), `result.pending` leaves it out — and it is resumed with `{ answeredBy:
"manager-17" }`, recorded on the pause and in `onExecutionResume`; the other credential (or an empty
`answeredBy`) is `PauseAnswererError` (`pause.wrong-answerer`). The decision is validated before
it is recorded — a `ToolCallApprovalDecisionDto` (`approved`, `reason?`, `overrideArguments?`
only with `approved: true`, checked by the tool's input), else `DtoValidationError` and the pause
keeps waiting:

<!-- snippet-context
import type { App } from "agboss";
declare const app: App;
declare const replyKey: string;
-->

```ts
// a webhook: the finance manager pressed "Approve" on the message whose reply key is the pauseId
const result = await app.resume(
  { pauseId: replyKey, decision: { approved: true } },
  { tenantId: "acme", answeredBy: "manager-17" },
);
```

Before its first step an execution reads each of its budgets (README → FinOps): one exhausted —
the tenant's day spent, say — refuses it with `BudgetExceededError` (`limit.budget`, an
`onExecutionRejected`), before anything is written: no thread (a new one is created once the budgets pass), no record, no model call.

`execute` and `resume` forward `signal`, `onStream` (token and tool-call events) and
`configurable` (extra LangGraph keys; the framework's own win). There is no untyped `metadata` or
`executionContext` option (#261): what an execution carries is its typed context values — a
channel, a guardrail or any component reads them through its injected `ExecutionContext`
(`this.executionContext.tenant.tenantId`, the project's own fields), and an MCP session
(`createMcpService(app, Mcp).connect(transport, { tenant, execution, ownerId })`) or an A2A call
(`adapter.execute(Start, request, onEvent, { tenant, execution, ownerId })`) passes them from its
authenticated caller. `app.cancel(threadId)` aborts a running
run — it stops before its next model or tool call and `execute` rejects with
`ExecutionCancelledError` — or drops a paused one, whose pauses are withdrawn: their `resume` then
throws `NotPausedError`;
`cancelled` is `false` when the thread had neither (a thread the tenant does not have is
`UnknownThreadError`). From `app.close()` on, `execute` and `resume`
are refused with `ApplicationStoppingError` (`app.stopping`, an `onExecutionRejected`); running executions
go on and `cancel` still works. An execution tree is moved by one holder at a time (#265, Q58):
`execute` and `resume` hold its lease (`seconds(30)`, renewed every 10 s and before every checkpoint
write, released when the pass ends). A `resume` first records its decision on its pause (`Pending →
Resolved`, atomic) — of two resumes of one pause the second gets `NotPausedError`, as does an
answer to a pause its step already took (`Taken`) or one withdrawn (`Cancelled`: the thread was
cancelled, or a sibling branch failed under `FailFast`) — then waits while another call or instance
holds the lease; the holder continues with every recorded answer of the tree in one pass and, before
the tree rests, takes the answers recorded meanwhile, so the waiting call returns the tree's current
output with its decision taken. An instance that lost the
lease (frozen past it) stops and its call rejects with `ExecutionLeaseLostError`
(`execution.lease-lost`) — no `onExecutionError`, no failed record: the new holder continues (Wiki →
Several-instances).

An execution's record is `ExecutionRecordStatus.Running` while its tree moves. **Recovery** (#265):
every instance looks for `running` roots at its start and every 30 s, takes the lease of each whose
holder died (its lease expired) or stopped (released it), and continues it from its last
checkpoint — a decision recorded meanwhile first — so only the interrupted step runs again; a root
started under another config is left to a compatible instance (logged once), unless
`onIncompatibleResume` says `"resume"`. Observers get `onExecutionResume` with
`reason: ResumeReason.Recovered` (`ResumeReason.Answered` for `app.resume`). With the in-memory
defaults nothing survives a restart, so recovery needs persistent stores — the SQLite ones on one
machine. **`app.close()`** stops
the sweep, runs `onStop`, waits for the running executions up to the shutdown timeout —
`@Application({ shutdownTimeout })`, `app.close({ timeout })`, default `seconds(25)` — then
interrupts them: each call rejects with `ApplicationStoppingError`, without `onExecutionError`, releases its
lease at once and stays `running`, so another instance continues it without waiting for the lease
to expire. `createApp` calls `app.close()` on SIGTERM / SIGINT (a second signal interrupts at once)
until the close finishes; `testWith` never listens.

<!-- snippet-context
import type { App } from "agboss";
import { seconds } from "agboss/units";
declare const app: App;
-->

```ts
// one instance of a rolling deploy stops: what still runs after 10 s moves to another instance
await app.close({ timeout: seconds(10) });
```

In unit tests, `testExecutionContext({ … })` from
`agboss/testing` is a frozen `ExecutionContext`: `new PayOrder(testExecutionContext())`; its
`tenant` and `tenant.application` are set with `{ tenantContext, tenant, application: {
environment } }`.

Observers are registered only in `@Application({ observers: [...] })` (#261) — one instance each,
created by the container at start with their `deps`, called for every execution of the
application (filter by `event.workflow.name === nameOf(SupportWorkflow)` — `nameOf(C)` gives the
`name` of any AGBoss-decorated class); none listed → none is
called. Each hook gets one event object, plain data, never the framework's internal state. Every
execution event (`ExecutionEvent`) carries `executionId`, `parentExecutionId`, `rootExecutionId`,
`threadId`, `tenantId` and `workflow` — a `WorkflowRecord` `{ name, version, startedVersion }`, no
class; a node event (agent, router, tool, model, knowledge base, guardrail, action,
channel, judge, `onValuesOutdated`, `onLaunchItemsTruncated`) adds `step`, a `StepRecord`
(`component: { name }`, `nodeId`, `visitNumber`, `copyNumber`, `itemIndex`, `idempotencyKey`,
`callId`) — the serialized `executionContext.step`. `onExecutionStart` fires once per execution (at
`execute`); one that pauses because nothing else can move emits `onExecutionPause` (`event.pending`:
every pause it waits for — again after a partial resume), `app.resume` and recovery emit
`onExecutionResume` (`event.reason`, `event.decision`, `event.answeredBy`), `onExecutionEnd` fires once
when it ends at a finish (`event.finish`: a `ComponentRecord`, `event.spend`) and
`onExecutionError` when it fails (`event.error`) — also after a resume; cancelling a paused
execution is an `onExecutionError` with `ExecutionCancelledError`. A request refused before an
execution starts or is located — another owner's thread, a `resume` of an unknown pause or one no
longer waiting, an
`execute` on an unknown thread or with an invalid input, an exhausted budget, a request after
`app.close()` — emits `onExecutionRejected` (`operation`: `ExecutionOperation.Execute | Resume |
Cancel`, `threadId` when given, `tenantId`, the error's stable `code`, a `message` without the input
values; never an `executionId`) and still throws. A resume refused as incompatible after a deploy
(`IncompatibleResumeError`) is an `onExecutionError` on the paused execution; it stays paused. A
write that renews a value of the path scope outdates what was built from the older one:
`onValuesOutdated` fires once per such cascade (the new value, each outdated value with its
`OutdatedReason`; never DTO values), and `result.record.outdatedValues` keeps the values themselves.
Assembly rejects an observer with no hook or with a misspelled one (`did you mean onToolEnd?`); an
observer that throws is a warning in the application's log (`observer.failed`) and never fails the
execution.

```ts
import {
  Application,
  EmptyEnvironment,
  Injectable,
  type AgentStartEvent,
  type ExecutionEndEvent,
  type ExecutionRejectedEvent,
  type OnAgentStart,
  type OnExecutionEnd,
  type OnExecutionRejected,
} from "agboss";

@Injectable()
export class MetricsObserver implements OnExecutionEnd, OnAgentStart, OnExecutionRejected {
  onExecutionEnd(event: ExecutionEndEvent): void {
    console.log(`${event.workflow.name} ${event.executionId} (tenant ${event.tenantId}) cost $${event.spend.totalUsd}`);
  }
  onAgentStart(event: AgentStartEvent): void {
    console.log(`${event.step.component.name} visit ${event.step.visitNumber} of ${event.executionId}`);
  }
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    console.log(`${event.operation} refused for ${event.tenantId}: ${event.code}`);
  }
}

@Application({
  name: "metrics-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [],
  observers: [MetricsObserver], // the only place observers are registered
})
export class MetricsApplication {}
```

### The framework's log

The framework logs through the application's `Logger` (#261) — infrastructure like the `Clock`:
the built-in `ConsoleLogger` writes one line per entry to standard error; your own `extends Logger`
(`write(entry: LogEntry)`) goes in `@Application({ providers })`. At start, once, it logs only what
the decorators say — what started, and the worst case of one call of each start in counts — then
the startup warnings; no project code is called (no `maxSpend()`), nothing per tenant:

```text
15:02:11 INFO  Started job-scout-application 1.0.0 — environment prod, host scout-7f3a, process 41237
15:02:11 INFO  Worst case of one chat-workflow-start call: 1 workflow execution, 1 at the same time, 12 agent and router steps
```

While it runs it logs only problems of the system — `LogLevel.Warn` at risk (a recovery left to a
compatible instance, an observer that threw), `LogLevel.Error` broken (a failed recovery, a failed
close) — each with its stable `code` and the `executionId` / `tenantId` it is about. One execution's
details are its trace, a tenant's spend is the cost ledger, a rejected execution is an observer
event. The startup warnings (`app.warnings`) include the **assembly warnings**: tenant or
application budgets on the built-in in-memory cost ledger (`[application.in-memory-cost-ledger]`:
each instance counts on its own, the counters reset on restart) and pauses possible with the
built-in in-memory paused executions or checkpoints (`[application.in-memory-pauses]`) — errors
under `agboss check --strict`, silent in tests (`testWith` logs no start and no warning; an unlisted
logger is silent there).

## FinOps

Every model call is a usage record (caller, model, tokens, USD) in the run's `spend`
(`ExecutionOutput.spend`: total, per caller, per category) and in the counters of every budget of
the execution (the application's `CostLedgerRepository`, in memory unless one is listed).

**Money limits are `@Budget` components** (#261), all of them in `@Application({ budgets })`
(written in `config/budget.config.ts`), one template — `@Budget({ name, scope, period?, workflow?,
deps? })` on a class that `implements BudgetHandler`, one method `maxSpend(): Usd | Promise<Usd>`:

- `BudgetScope.Execution` — one full pass of `app.execute`: a workflow's own (`workflow: X`, at
  most one) or the one default (no `workflow`) for every workflow without its own;
- `BudgetScope.Tenant` — one organization (`tenantId`) per `BudgetPeriod.Day | Week | Month` (UTC);
- `BudgetScope.Application` — the whole application per period.

Every workflow is covered (`[budget.execution-budget-required]`), there is at least one tenant and
one application budget (`[budget.tenant-budget-required]`, `[budget.application-budget-required]`),
and no workflow has two (`[budget.duplicate-execution-budget]`,
`[budget.duplicate-default-execution-budget]`) — checked at assembly. `maxSpend()` is read once per
execution, at its start, in its `ExecutionContext` (a budget injects it, or the project's tenant
context, or a service such as billing — a trusted source, never the request body) and kept for the
whole execution, a resume included; the ledger keeps the last one read. Before the first step every
budget is checked — one exhausted rejects the execution (`onExecutionRejected`); every model call's real
cost is then counted in all of them, and before the next step or model call the first exhausted
stops the execution with `BudgetExceededError` — `budget` (`{ name }`), `scope`, `key` (the
application's name, the `tenantId` or the execution's id), `maxSpend`, `spent`, and a sentence:
`tenant acme spent $40.05 today; tenant-daily-budget allows $40`. `.onError(BudgetExceededError, …)`
takes it. Nothing is reserved: a budget protects from draining money, so parallel executions of one
tenant may overrun it a little, and one call may cross it (its cost is known after it). A decision a
tool's service makes through `ROUTER_FACTORY` is the tool's spend (`tool:<name>`). A paid service
that is **not** a model is recorded with `SpendRecorder` (`deps: [SpendRecorder]`, in a `@Tool` or
an `@Action`): the record joins the spend of the current tool call or step and counts in the same
budgets. Called outside a step or a tool call, `record` throws `SpendOutsideStepError`
(`[spend.outside-step]`).

<!-- snippet-context
import { ExecutionContext, TenantContext } from "agboss";
import { Decimal } from "agboss/dto";
export class ShopTenantContext extends TenantContext {
  @Decimal()
  dailyBudgetUsd!: number;
}
-->

```ts
// config/budget.config.ts — the tenant's own amount, from its server-side data
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";

@Budget({
  name: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  deps: [ShopTenantContext],
})
export class TenantDailyBudget implements BudgetHandler {
  constructor(private readonly shopTenantContext: ShopTenantContext) {}

  maxSpend(): Usd {
    return usd(this.shopTenantContext.dailyBudgetUsd);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution, deps: [ExecutionContext] })
export class ExecutionBudget implements BudgetHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  maxSpend(): Usd {
    return this.executionContext.tenant.weight > 1 ? usd(0.5) : usd(0.1); // a bigger tenant
  }
}
```

A budget is unit-tested without the container —
`new TenantDailyBudget(testExecutionContext({ tenantContext: ShopTenantContext, tenant: { dailyBudgetUsd: 40 } }).tenant).maxSpend()`
is `usd(40)` — and an application test reaches an exhausted one the real way:
`mockOf(TenantDailyBudget).maxSpend.mockReturnValue(usd(0.01))` plus a scripted cost
(`replyWith(…, { cost: usd(0.02) })`). Steps are not money: `@Workflow({ maxSteps })` (default
(agents + routers) × 3; `StepsLimitExceededError`), checked at assembly too —
`[limits.max-steps-too-low]` when no finish fits in a hand-set `maxSteps`, or when the default
cannot hold the worst case of a per-item launch (`maxItems` runs: set `maxSteps`),
`[limits.branch-exceeds-max-steps]`, `[limits.max-steps-unused]`.

<!-- snippet-context
import { Text } from "agboss/dto";
export class SearchQueryDto {
  @Text({ prompt: "what to search the web for" })
  query!: string;
}
export class SearchResultsDto {
  @Text({ prompt: "what the search found" })
  text!: string;
}
-->

```ts
import { SpendRecorder, Tool, type ToolHandler } from "agboss";
import { usd } from "agboss/units";

@Tool({
  name: "web_search",
  description: "Searches the web (a paid API)",
  input: SearchQueryDto,
  output: SearchResultsDto,
  deps: [SpendRecorder],
})
export class WebSearchTool implements ToolHandler<SearchQueryDto, SearchResultsDto> {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  run({ query }: SearchQueryDto): Promise<SearchResultsDto> {
    this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) }); // → tool:web_search
    return Promise.resolve({ text: `results for ${query}` });
  }
}
```

## PII policies

A `@PiiPolicy` says which personal data the models never see as is (#120). Policies are listed in
`piiPolicies` of `@Application`, `@Workflow`, `@Agent` and `@Router`: the lists add up, and an agent
or a router removes an inherited one with `excludePiiPolicies` — for its own model and tools only;
logs, traces, observer events and `result.record` stay masked by the application's and the
workflow's lists. Masking happens only at the model boundary: what a model reads is masked, what
it gives back is revealed before any DTO is validated, so the scope, the checkpoint, every tool,
action and finish see real values. `replaceWithToken()` is the reversible one — a tool gets the
address the model only saw as `<email:7f3a91>` (an HMAC of the value with `pseudonymKey`; the
token map is kept in the execution's checkpoint). A `blockWithRefusal` rule fails the execution
with `PiiRefusedError` (`kind`, `refusal`) when the value comes in or is in an answer, and rejects
only the call when it is in tool arguments or a tool result.

<!-- snippet-context
import {
  Injectable,
  PiiAction,
  PiiGroup,
  PiiKind,
  PiiPolicy,
  pii,
  secret,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiRefusal,
} from "agboss";
import { Text } from "agboss/dto";
-->

```ts
@PiiPolicy({
  name: "customer-pii-policy",
  description: "Contact details hidden, cards refused, names found by a model",
  rules: [
    pii(PiiGroup.Contact, PiiAction.replaceWithKind()), // phones, addresses, postal codes
    pii(PiiKind.Email, PiiAction.replaceWithToken()), // a kind rule beats its group's
    pii(PiiKind.PersonName, PiiAction.replaceWithKind()),
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal()), // the text from refusal(kind)
  ],
  detectWithModel: "moonshotai/kimi-k2.6",
  pseudonymKey: secret("PII_PSEUDONYM_KEY"),
})
export class CustomerPiiPolicy implements PiiRefusal {
  refusal(kind: PiiKind): string {
    return `Please do not send a ${kind} here.`;
  }
}

@Injectable()
export class EmployeeDirectory {
  readonly ids: readonly string[] = ["EMP-0042"];
}

// a project's own detector: the framework applies `action` to every range it finds
@PiiPolicy({
  name: "employee-id-pii-policy",
  action: PiiAction.replaceWithToken(),
  deps: [EmployeeDirectory],
})
export class EmployeeIdPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly employeeDirectory: EmployeeDirectory) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.employeeDirectory.ids.flatMap((id) => {
      const start = text.indexOf(id);
      return start < 0 ? [] : [{ start, end: start + id.length }];
    });
  }
}

// a field without a format of its own: the same actions (masking ones only)
export class TicketDto {
  @Text({ prompt: "the customer's account", sensitive: PiiAction.replacePart({ keepLast: 4 }) })
  account!: string;
}
```

Assembly checks the lists: `[pii.conflicting-rules]` (two policies with different actions for one
kind, naming both), `[pii.exclude-not-inherited]`, `[pii.missing-refusal]`, `[pii.unused-refusal]`,
`[pii.kind-needs-model]` (a name or an address without `detectWithModel`), `[pii.not-a-policy]`.
Each `pseudonymKey` is read from its process variable when the app starts (a missing one fails the
start). The application's own key, `@Application({ pseudonymKey: "piiPseudonymKey" })`, names a
`Secret` field of its environment (`piiPseudonymKey: secret("PII_PSEUDONYM_KEY")`, like a model
provider's `apiKey`): the key of sensitive fields, of project detectors and of every policy without
its own — so one value is one token on every instance, and logs and traces from several machines
agree; a policy's own key wins, and a policy that needs the application's when it is not set fails
the start, naming the field. Under `testWith` an unset key gets a fixed test key, and `mockLlm(CustomerPiiPolicy)`
scripts its model detection (`pii:<policy>` in the spend). Wiki → Guards (PII).

## Tracing (local, optional)

```bash
scripts/langfuse.sh up   # self-hosted Langfuse in Docker, keys written to .env
```

Then every run is traced at http://localhost:3000. Details: [Wiki → Tracing](https://github.com/agbossjs/agboss/wiki/Tracing).

## The conveyor

Tickets move across the GitHub Project board of the repo:

| Stage              | Skill          | Result                                                                                                |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------- |
| Triage             | `triage`       | business side clarified through quizzes; issue(s) created or updated, split into sub-issues if needed |
| Backlog            | `spec-session` | spec, implementation plan, automated + manual acceptance criteria — in the issue                      |
| In progress → Test | `implement`    | independent issues in parallel; branch + PR per issue, merged to `main`; manual-test handoff          |
| Done               | a human        | after manual acceptance                                                                               |

Rules and the delivery pipeline: [`WORKFLOW.md`](WORKFLOW.md) · [`QUALITY.md`](QUALITY.md) ·
[`CLAUDE.md`](CLAUDE.md). Specs and plans live in GitHub Issues, docs in the GitHub Wiki.

## License

MIT — see [`LICENSE`](LICENSE).
