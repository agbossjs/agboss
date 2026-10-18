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
// src/job-scout.workflow.ts — the paths, defaults and providers; limits in settings()
import { Workflow, WorkflowSettings, route, start, type WorkflowDefinition } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { usd } from "agboss/units";

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
export class JobScout implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.1) }, perDay: { cost: usd(1) } })
      .build();
  }
}
```

The application is the one entry (#261): it lists the workflows, the infrastructure (a class that
`extends CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
LangGraph's `BaseCheckpointSaver` or one of the shared contracts of #265 — `ExecutionLeaseRepository`,
`ExecutionTreeRepository`, `RateLimitRepository`; none listed → the built-in in-memory ones, nothing
written to the home folder) and every budget. `createApp` and `testWith` take it, never a workflow:

```ts file=src/job-scout.application.ts
// src/job-scout.application.ts — what createApp(JobScoutApplication, { env }) and testWith run
import { Application, Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";
import { JobScout } from "./job-scout.workflow.js";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Application({
  name: "job-scout-application",
  version: "1.0.0",
  workflows: [JobScout], // app.execute(ChatWorkflowStart, …) runs the workflow of that start
  budgets: [TenantDailyBudget], // config/budget.config.ts in a project; checked from #261 PR 5
})
export class JobScoutApplication {}
```

A rule needs no model: `@Router({ decidedBy: DecidedBy.Code, routes: [{ target: A }, { target: B }] })`
on a class that `implements RouterHandler<Self>` decides in `route(input)`, returning one of its
targets (`Route<Self>`) — no model call, cost 0, the same flow. Routes may carry the options of a
parallel launch (#273): `spawn` (`SpawnPolicy.Always` by default on a model router's route,
`OnDemand` on a code router's) and `failure` (`FailurePolicy.FailFast` by default)
([Wiki → Routers](https://github.com/agbossjs/agboss/wiki/Routers)).

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

Needs `OPENROUTER_API_KEY` in `.env`. Docs: [Wiki → Components](https://github.com/agbossjs/agboss/wiki/Components) ·
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
router (`DecidedBy.Code`, `route(input)` through `deps`) beside a model router. Point the CLI at it:

```bash
cd examples/flow-patterns && npx agboss describe --workflow src/offer/offer.workflow.ts
```

More: [Wiki → Example](https://github.com/agbossjs/agboss/wiki/Example).

## Public entries

One package; the root `agboss` is the authoring API, the rest are focused entries:

- `agboss` — `@Workflow`, `@Agent`, `@Router`, `@Tool`, `@Injectable`, `@Action`,
  `@WorkflowStart` / `@WorkflowFinish`, `@Judge`, `@Guardrail`, `@PiiPolicy`, `@Channel`,
  `InjectionToken`, `provide`, `ENV`, `defineEnvironment`, `fromEnv`, the path builder (`start`,
  `agent`, `router`, `action`, `route`, `caseOf`, `toAgent`, `toAction`, `toFinish`, …),
  `WorkflowSettings`, `@Application`, `createApp`, `@Budget`, the infrastructure contracts,
  `Decision`, observers, errors and types
- `agboss/dto` — field decorators (`@Text`, `@ListOf`, …), the DTO wrappers (`listOf`, `oneOf`,
  `optional`, `variant`) and the standard DTOs
- `agboss/units` — `usd()`, `seconds()`, `minutes()`
- `agboss/models` — model providers
- `agboss/testing` — `testWith`, `replyWith`, `mcpOf`, VCR (+ `agboss/testing/setup`)
- `agboss/mcp`, `/rag`, `/a2a`, `/memory` — integrations (`@McpServer`, `@McpTool`,
  `@McpExpose`, `@Rag`, A2A, memory)

Importing `agboss` has no side effects: tracing, the MCP SDK and SQLite load only when an app
uses them. The old entries `agboss/core`, `/graph`, `/router`, `/tool` and `/channels` are
deprecated re-exports for one minor release (`/concurrency` went with the old flow DSL, #272); `agboss migrate imports` rewrites them
(and the renamed `Router` engine type → `RouterEngine`, root `McpServer` → `McpExpose` from
`agboss/mcp`, testing `Duration` → `ClockDuration`). Every entry's surface is in
`packages/agboss/api/*.api.md`; `npm run api:update` after an intended API change.

## Repository

```
packages/agboss/   the framework (published as `agboss`)
examples/job-scout/     the example (uses only the public API)
examples/flow-patterns/ the flow's patterns: a review loop, a code router (scripted tests only)
```

`make check` — build, API reports, compiled docs, format, lint, types, tests with coverage for both packages. `npm run dev` —
rebuild the framework on change. The framework never imports the examples, and the examples use
only `agboss` — both enforced by ESLint.

## Environments

Angular-style environment files, next to the application file in `environments/`. The application
itself says nothing about them.

```ts
// src/environments/environment.ts — the contract: which fields every environment has
declare module "agboss" {
  interface Environment {
    readonly apiUrl: string;
    readonly apiKey: string;
    readonly currency: string;
  }
}
export {};
```

```ts
// src/environments/dev.environment.ts — one file per environment: dev, staging, test, …
import { defineEnvironment, fromEnv } from "agboss";

export default defineEnvironment({
  apiUrl: "https://api.example.com", // a value in the file
  apiKey: fromEnv("API_KEY", { secret: true }), // a process variable, masked when printed
  currency: fromEnv("CURRENCY", { default: "USD" }), // a process variable with a default
});
```

`defineEnvironment` is typed by `Environment`: a missing or mistyped field is a `tsc` error in that
file. Services inject the values with the framework's `ENV` token:

```ts
import { ENV, Injectable, type Environment } from "agboss";

@Injectable({ deps: [ENV] })
export class Api {
  constructor(private readonly env: Environment) {}
}
```

- `agboss chat --workflow src/app.workflow.ts` (the application that lists it) loads `dev`; `--env staging` loads
  `staging.environment.ts` (every workflow command takes `--env`). An unknown name fails at once
  (exit 3) listing the available ones; a `fromEnv` variable without a value or default fails the
  start naming every missing variable. `agboss check` validates the selected environment without
  running anything, creating every component the start creates (tools, observers, judges, …), so it
  fails exactly when the start would; `agboss describe` shows it with secrets masked.
- From code: `createApp(Application, { env: "staging" })`. In tests:
  `testWith(Application, { env: "test" })` or `testWith(Application, { environment: { … } })`
  (typed by `Environment`).
- A service injecting `ENV` in an application without `environments/` fails at start with
  `[di.missing-environment]`.
- Model provider keys are not part of it: they stay process variables (`EnvironmentVariable.named`).

## Quality gates (judges)

`@Agent({ judges: [AnswerGrounded], maxRetries: 1 })` runs every judge on the agent's reply. A judge
is a `@Judge({ name, model, deps })` class implementing `JudgeHandler`; the container creates it with
its `deps`, and its **own** model is called through the model gateway, so its spend is in the run's
cost report (`judge:<name>`, category `review`). A rejected reply goes back to the agent with the
feedback; once `maxRetries` retries are spent the run throws `QualityGateError`
(`code: "step.agent.quality-gate"`, `feedback` per judge). A judge without a model fails at app start
(`[judge.no-model]`).

A judge gets what it judges as its input (`judge({ reply, task, attempt })`) and its model through
the constructor (`deps: [JudgeModel]`): a chat model (`judgeModel.invoke(...)`) or a **decision
model** (`judgeModel.decide({ state, questions })`) — every model of OpenRouter's Decisions API:
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
interface JobSearch {
  lastResults(): readonly string[];
}
const JOB_SEARCH = new InjectionToken<JobSearch>("JOB_SEARCH");
-->

```ts
import {
  Decision,
  Judge,
  JudgeModel,
  type JudgeHandler,
  type JudgeInput,
  type JudgeVerdict,
} from "agboss";

@Judge({
  name: "answer-grounded",
  model: "openai/gpt-6-luna-decisions",
  deps: [JudgeModel, JOB_SEARCH],
})
export class AnswerGrounded implements JudgeHandler {
  constructor(
    private readonly judgeModel: JudgeModel,
    private readonly jobSearch: JobSearch,
  ) {}

  async judge({ reply, task }: JudgeInput): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: { task, reply, results: this.jobSearch.lastResults() },
      questions: {
        grounded: Decision.noul("Every fact in the reply appears in the results"),
        tone: Decision.choice("Tone of the reply", {
          neutral: "Plain, factual",
          pushy: "Sells or pressures",
        }),
        quality: Decision.score("Overall usefulness", ["useless", "partial", "complete"]),
      },
    });
    // a.grounded.noul: number; a.tone.choice: "neutral" | "pushy"; a.quality.score: number
    return a.grounded.noul > 0.7 && a.tone.choice === "neutral"
      ? { passed: true }
      : { passed: false, feedback: "Only state facts from the search results, neutrally." };
  }
}
```

In tests, script a chat judge like an agent — `mockLlm(Judge).thenReturn(replyWith("PASS"))` — and a
decision judge with its answers by question id (an option, P(yes), a level's index or text):
`mockLlm(AnswerGrounded).thenReturn(decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }, { cost: usd(0.0002) }))`.

Routers and guards work on any decision model too (`@Router({ model: "openai/gpt-6-luna-decisions" })`):
one choice question over the routes, options sorted so declaration order never changes the request.

## Execution Context & Observers

Every component reads the execution it runs in through its constructor (#280):
`deps: [ExecutionContext]`, a parameter named `executionContext` — tools, actions, judges and
services alike; there is no `ctx` parameter. It is data only and read-only, and every read gives the
current execution and step (one frame per node visit and per tool call), so it is safe in an
component (one instance for the app) and in parallel branches. One execution has one id: its observer events
(`state.runId`), `executionContext.executionId`, its Tern (`Tern.runId`), its trace and its result
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
  executionContext.threadId; // the conversation (ExecutionOutput.thread)
  executionContext.ownerId; // from execute(…, { owner }): who the thread belongs to
  executionContext.signal; // aborted by app.cancel(thread) or the caller's signal
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
declare const thread: string;
declare const userId: string;
declare const signal: AbortSignal;
-->

```ts
await app.execute(
  ChatWorkflowStart,
  { text: "Find me a backend job" },
  { thread, owner: userId, signal, metadata: { tenant: "acme" } },
);
const { cancelled } = await app.cancel(thread, { owner: userId });
```

A thread created with an `owner` belongs to it: `execute` on that thread, `resume` and `cancel`
with another owner (or none) throw `ThreadOwnerError` (`run.thread-owner`) before anything runs or
is read. Tool arguments a channel shows (and `ExecutionOutput.pause.args`) have the input DTO's
`sensitive` fields masked as `***`; the tool itself still gets them whole.

Each run reserves its `limits.perRun.cost` of the day before its first model call, so concurrent
runs never jointly pass `limits.perDay.cost`; a workflow that sets `perDay.cost` without
`perRun.cost` fails at start with `[limits.per-run-required]`.

`execute` and `resume` forward `signal`, `metadata`, `onStream` (token and tool-call events) and
`configurable` (extra LangGraph keys; the framework's own win). `app.cancel(thread)` aborts a running
run — it stops before its next model or tool call and `execute` rejects with
`WorkflowCancelledError` — or drops a paused one, whose `resume` then throws `NotPausedError`;
`cancelled` is `false` when the thread had neither. From `app.close()` on, `execute` and `resume`
are refused with `ApplicationStoppingError` (`app.stopping`, an `onRunRejected`); running executions
go on and `cancel` still works. An execution tree is moved by one holder at a time (#265, Q58):
`execute` and `resume` hold its lease (`seconds(30)`, renewed every 10 s and before every checkpoint
write, released when the pass ends). A `resume` first records its decision — of two resumes of one
pause the second gets `NotPausedError` — then waits while another call or instance holds the lease,
and returns the tree's current output once the holder took its decision. An instance that lost the
lease (frozen past it) stops and its call rejects with `ExecutionLeaseLostError`
(`execution.lease-lost`) — no `onError`, no failed record: the new holder continues (Wiki →
Several-instances).

An execution's record is `ExecutionRecordStatus.Running` while its tree moves. **Recovery** (#265):
every instance looks for `running` roots at its start and every 30 s, takes the lease of each whose
holder died (its lease expired) or stopped (released it), and continues it from its last
checkpoint — a decision recorded meanwhile first — so only the interrupted step runs again; a root
started under another config is left to a compatible instance (logged once), unless
`onIncompatibleResume` says `"resume"`. Observers get `onWorkflowResume` with
`reason: ResumeReason.Recovered` (`ResumeReason.Answered` for `app.resume`). With the in-memory
defaults nothing survives a restart, so recovery needs persistent stores. **`app.close()`** stops
the sweep, runs `onStop`, waits for the running executions up to the shutdown timeout —
`@Application({ shutdownTimeout })`, `app.close({ timeout })`, default `seconds(25)` — then
interrupts them: each call rejects with `ApplicationStoppingError`, without `onError`, releases its
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
`agboss/testing` is a frozen `ExecutionContext`: `new PayOrder(testExecutionContext())`.

Observers see a run's workflow, agent, router, tool, model, guardrail, policy, action, channel and
judge start/end events. `onWorkflowStart` fires once per run (at `execute`); a run that pauses emits
`onWorkflowPause` (`event.pause`: what it waits for), `app.resume` emits `onWorkflowResume`
(`event.decision`), and `onWorkflowEnd` / `onError` fire when the run finishes or fails — also
after a resume; cancelling a paused run is an `onError` with `WorkflowCancelledError`. Every event
carries the run's one `runId` and its real `threadId`. A request refused before a run starts or is
located — another owner's thread, a `resume` with nothing paused, an `execute` on an unknown thread
or with an invalid start input, a request after `app.close()` — emits `onRunRejected` (`operation`, `threadId` when given, the
error's stable `code`, a `message` without the input values; never a `runId`) and still throws. A
resume refused as incompatible after a deploy (`IncompatibleResumeError`) is an `onError` on the
paused run, with its `runId` and thread; the run stays paused. A write that renews a value of the
path scope outdates what was built from the older one: `onValuesOutdated` fires once per such
cascade (the step, the new value, each outdated value with its `OutdatedReason`; never DTO values),
and `result.record.outdatedValues` keeps the values themselves. Only classes listed in `@Workflow({ observers: [...] })` are called; the
container creates them at app start, with their `deps`. Each hook has its own interface and payload
type; assembly rejects an observer with no hook or with a misspelled one (`did you mean onToolEnd?`).
An observer that throws is reported as a process warning and never fails the run.

```ts
import {
  Injectable,
  type AppState,
  type AgentStartEvent,
  type OnAgentStart,
  type OnRunRejected,
  type OnWorkflowStart,
  type RunRejectedEvent,
} from "agboss";

// listed in the workflow: @Workflow({ …, observers: [MetricsObserver] })
@Injectable()
export class MetricsObserver implements OnWorkflowStart, OnAgentStart, OnRunRejected {
  onWorkflowStart(state: AppState) {
    console.log(`Run ${state.runId} started`);
  }
  onAgentStart(event: AgentStartEvent) {
    console.log(`Agent ${event.name} started in run ${event.state.runId}`);
  }
  onRunRejected(event: RunRejectedEvent) {
    console.log(`${event.operation} refused: ${event.code}`);
  }
}
```

## FinOps

Every model call is a usage record (caller, model, tokens, USD) in the run's `spend`
(`ExecutionOutput.spend`: total, per caller, per category) and in the daily ledger (the
application's `CostLedgerRepository`, in memory unless one is listed); the money limits
of `settings().limits({ perRun: { cost }, perDay: { cost } })` are checked before every model call
and every agent or router visit, and crossing one fails the run with `BudgetExceededError`. A
decision a tool's service makes through `ROUTER_FACTORY` is the tool's spend (`tool:<name>`). A
paid service that is **not** a model is recorded with `SpendRecorder` (`deps: [SpendRecorder]`, in
a `@Tool` or an `@Action`): the record joins the spend of the current tool call or step and counts
in the same limits. Called outside a step or a tool call, `record` throws `SpendOutsideStepError`
(`[spend.outside-step]`).

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
