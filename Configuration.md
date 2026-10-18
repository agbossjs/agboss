# Configuration

Set in the application's and the workflow's components ([Components](Components)): defaults of
every workflow in `@Application`, workflow-wide fields in `@Workflow`,
limits and model providers in its `settings()`, agent fields in each `@Agent`, router fields in each
`@Router`. Assembled and validated at startup; [profiles](Profiles-and-comparisons) override them
without code. Secrets are never there — model provider keys are process variables
(`OPENROUTER_API_KEY` in `.env`), the app's own settings live in [environments](Environments).

<!-- snippet-context
import { Agent, Workflow, WorkflowFinish, WorkflowSettings, WorkflowStart, start, type WorkflowDefinition } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { McpServer, McpServerClient } from "agboss/mcp";
import { DecisionsModelProvider, OpenRouterModelProvider, Reasoning } from "agboss/models";
import { usd } from "agboss/units";
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@Agent({ name: "scout-agent", description: "Finds jobs", prompt: "Find jobs on {{boards}}.", model: "moonshotai/kimi-k2.6" })
export class ScoutAgent {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
const tools = {};
@McpServer({ name: "shortlist", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], tools })
export class ShortlistServer extends McpServerClient<typeof tools> {}
-->

```ts
@Workflow({
  name: "job-scout-workflow", // kebab-case, ends with -workflow — the key of the daily spend ledger
  version: "2.0.0", // labels every run; profiles set their own
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScoutAgent)
      .toFinish(ChatWorkflowFinish),
  ],
  defaults: {
    models: { temperature: 0 }, // every chat model (agents, LLM routers)
    router: { model: "typesafe/jev-1.13" }, // routers without their own model, tools' decisions
    guardrail: { model: "typesafe/jev-1.13" }, // guards without their own model — never the router's
    tools: { maxToolCalls: 8 },
    history: { limit: 5 },
  },
  maxSteps: 12, // visits of agents and routers in one run
  guards: {
    input: { prompt_injection: { threshold: 0.7, refusal: "I can't help with that request." } },
  },
  compaction: {
    every: 5,
    keep: 10,
    model: { model: "moonshotai/kimi-k2.6", reasoning: Reasoning.off() },
  },
  mcp: [ShortlistServer],
  promptVariables: { boards: "acme (Acme)" },
})
export class JobScout implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.1) }, perDay: { cost: usd(1) } })
      .modelProviders([OpenRouterModelProvider, DecisionsModelProvider])
      .build();
  }
}
```

## The `defaults` cascade — application → workflow → component (#261)

`@Application({ defaults })` holds the defaults of every workflow it lists; `@Workflow({ defaults })`
the workflow's own; a component's own field (`@Agent({ maxTokens })`, `@Router({ model })`, a guard's
`model`) wins over both. The levels are merged **field by field** — a workflow that sets only
`history.limit` takes the rest from the application — and the most specific level that sets a field
wins; nothing set → the framework's built-in.

<!-- snippet-context
import { Application, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "ask-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class AskWorkflowStart {}
@WorkflowFinish({ name: "ask-workflow-finish", description: "The question, as is", output: WorkflowStartTextDto })
export class AskWorkflowFinish {}
// @snippet
-->

```ts
import { EmptyEnvironment } from "agboss";
@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(AskWorkflowFinish),
  ],
  defaults: { history: { limit: 8 } }, // its own: over the application's history.limit
})
export class AskWorkflow {}

@Application({
  name: "ask-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AskWorkflow],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" }, // DecidedBy.Model routers without their own model
    guardrail: { model: "typesafe/jev-1.13" }, // guards without their own model
    history: { limit: 5, summaries: 2 }, // ask-workflow: limit 8, summaries 2
  },
})
export class AskApplication {}
```

`agboss describe` shows where each value came from — a router's model `(own)` or
`(defaults.router.model of ask-application)`, an agent's `defaults: temperature 0 (ask-application)
· maxTokens 512 (own) · history 8 (ask-workflow)`, `(built-in)` when no level sets it. Closed sets
of values are enums (`Reasoning`, …), never strings.

## `defaults.models` — applied to every chat model (agents and LLM routers)

| Field         | Values                                                                                                                                                       | Default        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `temperature` | 0–2                                                                                                                                                          | required       |
| `maxTokens`   | positive int, or `MODEL_MAX` (`"max"`) for no ceiling — set explicitly                                                                                       | `8192`         |
| `reasoning`   | override of the provider's reasoning: `Reasoning.modelDecides()` · `Reasoning.off()` · `Reasoning.on({ effort?, budget? })` (#269: no string forms) | the provider's |
| `cache`       | override of the provider's caching: `true` = the provider's · `false` = off · a `PromptCaching` value                                                       | the provider's |

Timeouts, retries, circuit breakers, request fields (e.g. OpenRouter's `provider: { ignore: [...] }`)
and costs belong to the **model provider** — see [Model providers](Model-providers); `price` on an
agent is an optional override of the provider's price table. Every setting is checked against its
model at startup and by `agboss check --models`.

## `defaults.tools`

| Field          | Meaning                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxToolCalls` | optional: tool calls per call of an agent (`agents.<name>.limits.toolCalls`, default 20); crossing it fails the run — see [Agents](Agents#limits-per-call-of-the-agent) |

## `defaults.history`

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `limit`     | how many previous Terns of the thread routers and agents see              |
| `summaries` | how many latest compaction summaries they see (default `compaction.keep`) |

Per agent: `@Agent({ historyLimit, historySummaries })`, or a `memoryStrategy`
([Memory Management](Memory-Management)).

## `defaults.router` — the model for routers and components' decisions

`{ model: "typesafe/jev-1.13" }` — a decision model or a chat model; there is no `kind`, the model
registry knows which it is. A `DecidedBy.Model` router without its own `model` uses it, its own
`model` wins, `DecidedBy.Code` routers ignore it; a model router with no model anywhere fails
assembly: `[router.no-model] main-router uses DecidedBy.Model but has no model — set model or
defaults.router.model` — see [Routers](Routers). `ROUTER_FACTORY` routers and eval's judge use it
too.

## `defaults.guardrail` — the model for guards

`{ model: "typesafe/jev-1.13" }` — separate from `defaults.router`: a guard never takes the router's
model, and the framework has no built-in guardrail model. A guard's own `model` wins; a guard with no
model anywhere fails assembly: `[guardrail.no-model] prompt_injection has no model — set model or
defaults.guardrail.model` (#261; #120 turns guards into guardrails).

## Limits — `maxSteps`, `maxVisits`, `settings().limits(...)`

`@Workflow({ maxSteps })` — visits of agents and routers in one run (default (agents + routers) × 3);
`maxVisits` on a router or an agent — its visits in one run; money in `settings()`:
`perRun: { cost }` and `perDay: { cost }` (values with units: `usd()` from `agboss/units`). Hitting
one **fails the run** — unless an `.onError(…)` takes it — with `LimitExceededError` naming the key
(`maxSteps`, `<node>.maxVisits` as `VisitsLimitExceededError`, `limits.perRun.cost`,
`limits.perDay.cost`). `perDay.cost` requires `perRun.cost` (`[limits.per-run-required]`). Details:
[FinOps](FinOps).

## `mcp` — `@McpServer` classes

| Transport | Fields                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `stdio`   | `command`, `args?`, `env?` — **names** of env variables passed to the process |
| `http`    | `url`, `headers?` — header → **name** of the env variable with its value      |

A used server that is missing, unreachable, lacks an env variable or has a drifted contract stops
startup. See [Mcp](Mcp).

## Agents

From `@Agent` classes: `model`, `description` (shown to routers), `prompt` / `promptUrls` /
`promptVariables`, `tools` (class references — a missing one does not compile), `maxToolCalls`,
`historyLimit`, `historySummaries`, `judges` + `maxRetries`, `rag`, `memoryStrategy`, `input` / `output`, `maxVisits`,
`price`, and any `defaults.models` field as an override.

## `guards`

Input and output guards: `threshold`, `refusal`, optional `model` per guard (else
`defaults.guardrail.model`). See [Guards](Guards).

## `compaction` (optional)

`every` turns per summary (≥ 2), `keep` summaries readers see by default (the queue drops the oldest),
`model` — the model that writes them. Readers: `defaults.history.summaries`, per agent
`historySummaries` (0 = none); `historyLimit` caps the raw turns since the last compaction. A workflow
may override the prompt (`compactionPrompt`). See
[Terns and evaluation](Terns-and-evaluation#conversation-memory-compaction).

## Environments

The app's own settings: one set per application, in `environments/` next to the application file —
the contract a class with declared fields only (`@Application({ environment: AppEnvironment })`), each
environment a typed object literal, secrets `Secret` fields from process variables. See
[Environments](Environments).

A framework implementation listed in `@Application({ providers })` may need a field of the
contract: every SQLite implementation reads **`sqlitePath`** — the one file of the application's
SQLite stores (`:memory:` in tests, `env("AGBOSS_SQLITE_PATH")` in production), required only when
one is listed (`[environment.missing-field]` names the implementation and the contract). See
[Several instances → SQLite](Several-instances#sqlite--several-instances-on-one-machine).
