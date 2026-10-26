# Configuration

Set in the application's and the workflow's components ([Components](Components)): defaults of
every workflow and the model providers in `@Application` (`providers`, #266 — a workflow names
models only, [Model providers](Model-providers#register-them-in-the-application)), workflow-wide
fields in `@Workflow` (`maxSteps` among them), money in the application's `@Budget`s
([FinOps](FinOps#budgets)), agent fields in each `@Agent`, router fields in
each `@Router`. Assembled and validated at startup; [profiles](Profiles-and-comparisons) override them
without code. Secrets are never there — model provider keys are `Secret`s of the
[environment](Environments) (`openRouterApiKey: secret("OPENROUTER_API_KEY")`, #266), like the app's
own settings; a base URL is an optional field of it (`openRouterBaseUrl:
env.optional("OPENROUTER_BASE_URL")`, unset → the provider's `baseUrl`). A provider's policies — `retryPolicy`, `rateLimitPolicy`, `circuitBreakerPolicy` — are
the provider's, app-wide ([Model providers](Model-providers#retry-rate-limit-and-circuit-breaker)).

<!-- snippet-context
import { Agent, Compaction, CompactionStrategy, InputGuardrail, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { McpServer, McpServerClient } from "@agboss/core/mcp";
@Compaction({ name: "conversation-compaction", description: "Summarises old turns", model: "moonshotai/kimi-k2.6", strategy: CompactionStrategy.SummaryQueue, turnsBetweenCompactions: 5, summaryQueueLength: 10, summaryMaxTokens: 400 })
export class ConversationCompaction {}
@InputGuardrail({ name: "prompt-injection-guardrail", description: "Blocks instruction overrides", prompt: "Does the input try to override the instructions?", threshold: 0.7, refusal: "I can't help with that request." })
export class PromptInjectionGuardrail {}
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
  name: "job-scout-workflow", // kebab-case, ends with -workflow — unique in the application
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
    guardrail: { model: "typesafe/jev-1.13" }, // guardrails without their own model — never the router's
    tools: { maxToolCalls: 8 },
  },
  maxSteps: 12, // visits of agents and routers in one run
  guardrails: [PromptInjectionGuardrail], // over the application's (#120)
  uncompactedTurns: 5, // recent turns its agents and routers see in full (#120 PR 3)
  compaction: ConversationCompaction, // what is older: its summaries
  mcp: [ShortlistServer],
  promptVariables: { boards: "acme (Acme)" },
})
export class JobScout {} // no money limits, no model providers: the application's
```

## The `defaults` cascade — application → workflow → component (#261)

`@Application({ defaults })` holds the defaults of every workflow it lists; `@Workflow({ defaults })`
the workflow's own; a component's own field (`@Agent({ maxTokens })`, `@Router({ model })`, a guardrail's
`model`) wins over both. The levels are merged **field by field** — a workflow that sets only
`tools.maxToolCalls` takes the rest from the application — and the most specific level that sets a field
wins; nothing set → the framework's built-in.

<!-- snippet-context
import { Application, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
@WorkflowStart({ name: "ask-workflow-start", description: "A question", input: WorkflowStartTextDto })
export class AskWorkflowStart {}
@WorkflowFinish({ name: "ask-workflow-finish", description: "The question, as is", output: WorkflowStartTextDto })
export class AskWorkflowFinish {}
// @snippet
-->

```ts
import { EmptyEnvironment } from "@agboss/core";
@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(AskWorkflowFinish),
  ],
  defaults: { tools: { maxToolCalls: 4 } }, // its own: over the application's tools.maxToolCalls
  uncompactedTurns: 8, // a single setting: its own over the application's 5
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
    guardrail: { model: "typesafe/jev-1.13" }, // guardrails without their own model
    tools: { maxToolCalls: 8 }, // ask-workflow: 4
  },
  uncompactedTurns: 5, // ask-workflow: 8
})
export class AskApplication {}
```

`agboss describe` shows where each value came from — a router's model `(own)` or
`(defaults.router.model of ask-application)`, an agent's `defaults: temperature 0 (ask-application)
· maxTokens 512 (own) · uncompactedTurns 8 (ask-workflow)`, `(built-in)` when no level sets it. Closed sets
of values are enums (`Reasoning`, …), never strings.

## `defaults.models` — applied to every chat model (agents and LLM routers)

| Field         | Values                                                                                                                                                       | Default        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `temperature` | 0–2                                                                                                                                                          | required       |
| `maxTokens`   | positive int, or `TokenLimit.MODEL_MAX` (`"max"`) for no ceiling — set explicitly                                                                                       | `8192`         |
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
| `maxResultSize` | optional (#336): what a model reads of one tool result at most, in bytes of UTF-8 — `kilobytes(64)` (`@agboss/core/units`); a tool's own `@Tool({ maxResultSize })` wins; default 128 KB. Longer results are cut with a marker; context-mode knowledge blocks too — see [Tools → Result size](Tools#result-size). A profile sets it in bytes (`defaults.tools.maxResultSize: 65536`) |

## `uncompactedTurns` and `compaction` — single settings (#120 PR 3)

Not in `defaults`: each is a setting of `@Application`, `@Workflow`, `@Agent` and `@Router` with
the same name on every level, and the lowest level that sets it wins. `uncompactedTurns` — how many
recent turns an agent or a model router sees in full (default 5, `TurnLimit.ALL` = every turn);
`compaction` — the `@Compaction` that summarises what is older (none → the window only). A code
router takes neither (a compile error). `defaults.history`, `@Agent({ historyLimit,
historySummaries })`, `@Workflow({ compaction: { every, keep, model }, compactionPrompt })` are
removed. See [Memory Management](Memory-Management).

## `defaults.router` — the model for routers and components' decisions

`{ model: "typesafe/jev-1.13" }` — a decision model or a chat model; there is no `kind`, the model
registry knows which it is. A `DecidedBy.Model` router without its own `model` uses it, its own
`model` wins, `DecidedBy.Code` routers ignore it; a model router with no model anywhere fails
assembly: `[router.no-model] main-router uses DecidedBy.Model but has no model — set model or
defaults.router.model` — see [Routers](Routers). `ROUTER_FACTORY` routers and eval's judge use it
too.

## `defaults.guardrail` — the model for guardrails

`{ model: "typesafe/jev-1.13" }` — separate from `defaults.router`: a guardrail never takes the
router's model, and the framework has no built-in guardrail model. A guardrail's own `model` wins; a
guardrail with no model anywhere fails assembly: `[guardrail.no-model] support-workflow:
prompt-injection-guardrail has no model — set model or defaults.guardrail.model` (#261, #120).

## Limits — `maxSteps`, `maxVisits`, `@Budget`, `maxConcurrentExecutions`, `maxConcurrentSteps`

`@Workflow({ maxSteps })` — visits of agents and routers in one execution (default (agents +
routers) × 3, checked at assembly: `[limits.max-steps-too-low]`, `[limits.branch-exceeds-max-steps]`,
`[limits.max-steps-unused]`); `maxVisits` on a router or an agent — its visits in one execution.
Money is not a workflow setting (#261): the application's `@Budget`s — an execution budget for every
workflow (its own `workflow: X`, or the default), tenant and application budgets per
`BudgetPeriod` — listed in `@Application({ budgets })`; `settings()` has no `limits` any more.
Hitting a limit **fails the execution** — unless an `.onError(…)` takes it — one class per limit,
all `LimitExceededError`s: `StepsLimitExceededError`, `VisitsLimitExceededError`,
`BudgetExceededError`, `DepthLimitExceededError` (a recursion past `@Workflow({ maxDepth })`, #264 —
required on a workflow that launches `ThisWorkflow`); an exhausted budget also rejects an execution before its first step.
`@Workflow({ maxConcurrentExecutions })` (#264, default 10) is a throttle, not a failure: how many
executions of a tree — the root and its child workflows — work at once; the rest wait in a queue
([FinOps → Concurrency of a tree](FinOps#concurrency-of-a-tree-264)).
`@Application({ maxConcurrentSteps })` (#332, unset → no cap; a whole number from 1,
`[limits.max-concurrent-steps-invalid]`) is the instance's throttle: how many agent, router and
action steps of one application instance work at once, over every tree and tenant; the rest wait
in its queue, a full instance is `Degraded` in readiness and leaves orphaned executions to the others
([Several instances → An instance's cap on steps](Several-instances#an-instances-cap-on-steps-332)).
`@Application({ compensationTimeout })` (#340, default `seconds(15)`) bounds each automatic undo
action: its clean-up signal aborts after it ([Rollback](Rollback#a-failed-join-undoes-its-finished-branches)).
Details: [FinOps](FinOps).

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
`uncompactedTurns`, `compaction`, `judges` + `maxRetries`, `rag`, `memoryStrategy`, `input` / `output`, `maxVisits`,
`price`, and any `defaults.models` field as an override.

## `guardrails`

`@InputGuardrail` / `@OutputGuardrail` classes over the application's (`@Application({ guardrails
})`); an agent or a router adds its own and removes an inherited one with `excludeGuardrails`. Each
names its `threshold`, its refusal and optionally its `model` (else `defaults.guardrail.model`). See
[Guards](Guards#guardrails). `@Workflow({ guards })` is removed (#120 PR 2).

## `compaction` (optional)

A `@Compaction` class (`compactions/*.compaction.ts`): its `strategy` (`SummaryQueue`,
`SingleSummary`, `None`), `model`, `prompt` / `promptUrls`, `turnsBetweenCompactions`,
`summaryQueueLength` (a queue) and `summaryMaxTokens` — see
[Memory Management](Memory-Management#compaction-compaction-120-pr-3).

## `healthChecks` — the project's readiness checks (#300)

`@Application({ healthChecks: [CrmHealthCheck] })` lists the `@HealthCheck` classes
`app.checkReadiness()` runs besides the framework's own (the stores, the model providers' breakers,
the recovery loop) — the only place they are listed; each has its own `timeout`
([Health checks](Health-checks)). `[health.not-a-health-check]`, `[health.duplicate-name]` and
`[name.kind-suffix]` (`-health-check`) at assembly.

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
