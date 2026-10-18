# Model providers

Every model a workflow uses — an agent's, compaction's, a router's, a guard's, a judge's — comes
from a **model provider**: an `@ModelProvider` class from `agboss/models`. The provider says which
models it serves, how it is reached (base URL, key, timeout), what a call costs, how its models
reason and cache by default, and what happens when a call fails (retry policy, circuit breaker).
Introduced in #151 ([ADR-0016](ADR-0016-Model-providers)); since #266 model providers are
**application infrastructure**: listed in `@Application({ providers })`, shared by every workflow
of the application — a workflow and its components name models only and never pick a provider.

## A provider

```ts file=src/model-providers/openrouter.model-provider.ts
import {
  CachedPart, CacheRetention, EnvironmentVariable, ModelCost, ModelFailure, ModelProvider,
  OpenRouterProvider, PromptCaching, ProviderSort, Reasoning, RetryPolicy, type OpenRouterFields,
} from "agboss/models";
import { minutes, seconds } from "agboss/units";

@ModelProvider({
  name: "openrouter",                                   // identifies it — never its base URL
  description: "OpenRouter — many models behind one OpenAI-compatible API",
  serves: [/.*/],                                       // which model names it serves
  baseUrl: "https://openrouter.ai/api/v1",              // or EnvironmentVariable.named("…", { defaultValue })
  apiKey: EnvironmentVariable.named("OPENROUTER_API_KEY", { secret: true }),
  timeout: minutes(2),                                  // per attempt
  cost: ModelCost.fromResponse(),                       // OpenRouter returns usage.cost
  reasoning: Reasoning.modelDecides(),                  // required here; components may override
  promptCaching: PromptCaching.whereSupported({         // required here; components may override
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3, initialDelay: seconds(1), maxDelay: seconds(20), jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) }, // fallback?: another provider
})
export class OpenRouterModelProvider extends OpenRouterProvider {
  // OpenRouter's provider routing: skip an upstream, order the rest by price (ProviderSort, #269)
  override readonly requestFields: OpenRouterFields = {
    provider: { ignore: ["Inceptron"], sort: ProviderSort.Price },
  };
}
```

`ProviderSort.Price` / `Throughput` / `Latency` — OpenRouter's `provider.sort`; closed sets are
enums, so a string (`"price"`) does not compile.

## Register them in the application

`@ModelProvider` classes are listed **only** in `@Application({ providers })`, next to the rest of the
infrastructure ([App](App)). They are not created by the container (nothing injects a provider), and
one in a workflow's `providers` fails the application's assembly with
`[di.infrastructure-in-workflow] … is a @ModelProvider — infrastructure is listed only in
@Application({ providers })`.

<!-- snippet-context
import { Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The message", output: WorkflowStartTextDto })
export class ChatWorkflowFinish {}
@Workflow({
  name: "job-scout-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ChatWorkflowFinish),
  ],
})
export class JobScout {}
// @snippet
-->

```ts file=src/job-scout.application.ts
import { Application, EmptyEnvironment } from "agboss";
import { DecisionsModelProvider } from "agboss/models";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";

@Application({
  name: "job-scout-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JobScout],
  // chat models through job-scout's own OpenRouter, decision models through the Decisions API
  providers: [OpenRouterModelProvider, DecisionsModelProvider],
})
export class JobScoutApplication {}
```

- **None listed** → the built-in `OpenRouterModelProvider` (every chat model) and
  `DecisionsModelProvider` (the decision models, `DECISION_MODELS`).
- **At least one listed** → the list is complete: the built-ins are **not** added next to it, so
  what serves each model is visible in one place. An application listing only a local server and
  using Jev lists `DecisionsModelProvider` too, or its routers fail with `[model.unserved]`.
- A workflow has no provider setting (`settings().modelProviders(…)` and `defaultModelProvider(…)`
  were removed in #266), and no component has one.

job-scout: `src/model-providers/openrouter.model-provider.ts`, listed in `job-scout.application.ts`;
`agboss create` generates the same.

### Built in

| Class                               | What it is                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenAiCompatibleProvider<Fields>`  | any OpenAI-compatible server; `requestFields` is a typed member (`override readonly requestFields: Fields = { … }`) — a typo is a compile error. OpenAI's dialect: `reasoning_effort`, `prompt_cache_key`, `prompt_cache_retention`. |
| `OpenRouterProvider<Fields>`        | OpenRouter's dialect: `reasoning: { effort \| max_tokens, exclude }`, `usage: { include: true }` (the cost in every answer), `cache_control` markers for Anthropic and Google models, a model list that says what each model supports. `OpenRouterFields`: `provider` routing, `transforms`. |
| `OpenRouterModelProvider`           | the default chat provider (above, without request fields)                                                                                                                            |
| `DecisionsModelProvider`            | OpenRouter's Decisions API: serves the decision models (`DECISION_MODELS`: `typesafe/jev-*`, `openai/gpt-6-luna-decisions`, pplx-decider, Clef, …) for **decisions only** (routers, guards, decision judges); `JevModelProvider` is its deprecated alias |
| own provider                        | implement `ModelProviderHandler`: `chat?(request)` → a LangChain chat model, `routeTo?(request)`, `capabilities(model, connection)` (`undefined` = not served)                         |

## Which provider serves a model

- Exactly **one** listed provider must match the model name **for its purpose** — a chat model
  (agents, compaction, LLM routers, chat judges) needs a provider with `chat`, a decision (Jev and
  the other decision models: routers, guards, decision judges) one with decisions. So OpenRouter on
  `/.*/` and the decision models never clash.
- Checked for **every** model of the application at assembly — agents, model routers, the default
  router (`defaults.router.model`), guards, compaction and judges (arbiters and reply interpreters
  join when they exist, #267) — all at once, before any model call (`createApp`, `testWith`,
  `agboss check`):
  - none → `[model.unserved] job-scout-workflow agents.scout-agent = local/llama: no listed provider
    serves it for chat (listed: openrouter, decisions) — list a @ModelProvider that serves it in
    @Application({ providers })`;
  - several → `[model.ambiguous-provider] … served by several providers: local, local-mirror — one
    model string per provider, each in one serves`. No default breaks the tie: one model through
    two providers is two model strings, each in one provider's `serves`.
- `agboss describe` prints the provider each model resolves to, though no component names it
  (`--json`: `models: [{ key, model, provider }]`):

```
models
  agents.scout-agent  model: moonshotai/kimi-k2.6 → openrouter
  routers.main-router  model: typesafe/jev-1.13 → decisions
```

## Cost

- `ModelCost.fromResponse()` — the provider reports each call's cost in its answer (`usage.cost`),
  recorded as `costSource: "api"`.
- `ModelCost.fromPrices({ "<model>": { inputPerMillion: usd(…), outputPerMillion: usd(…), cachedInputPerMillion?: usd(…) } })`
  — tokens × the table (`price-table`); a model it does not price → `model.no-price` at startup.
- The reported cost always comes first; a component's own `price` overrides the table. A call with
  neither fails (`ModelCostError`) — an unaccounted call is never silently free. Limits per run and
  per day ([FinOps](FinOps)) use these costs.

## Reasoning

`Reasoning.modelDecides()` (nothing sent) · `Reasoning.on({ effort?: ReasoningEffort.Low | Medium | High | Minimal | ExtraHigh, budget?: { tokens } })`
(at least one, both allowed where the model takes both) · `Reasoning.off()`.

Required on the provider; a component overrides it with `reasoning: Reasoning.…` on `@Agent` /
`@Workflow({ defaults: { models: { reasoning } } })` (#269: only `Reasoning` values, no string
forms). Unset on the component = the provider's.

## Prompt caching

`PromptCaching.whereSupported({ retention: CacheRetention.FiveMinutes | OneHour | OneDay, cachedParts: [CachedPart.SystemPrompt | Tools | History], key? })`
· `PromptCaching.off()`. Where the model caches automatically (OpenAI, Kimi, DeepSeek…) nothing is
marked; Anthropic and Google models get `cache_control` after the stable prefix (the system prompt,
which ends the tools + system prefix) and at the previous turn's end (history as a growing prefix),
with `ttl: "1h"` for `OneHour`; OpenAI's dialect sends `prompt_cache_key` and
`prompt_cache_retention: "24h"`. A component overrides it with `cache` until #152 (`true` = the
provider's, `false` = off, or a `PromptCaching` value).

## Retry and circuit breaker

- `RetryPolicy.exponential({ maxAttempts, initialDelay, maxDelay, jitter, retryOn })` ·
  `RetryPolicy.fixed({ maxAttempts, delay, retryOn })` · `RetryPolicy.none()` — every field
  required. Only the listed `ModelFailure`s (`Timeout`, `RateLimited`, `ServerError`,
  `NetworkError`) are retried; a client error (4xx) is the answer.
- `Retry-After` is honoured; one longer than the policy's longest wait (`maxDelay`, or `delay`) ends
  the retries with the provider's answer — never an early retry, never an unbounded wait.
- Retries are one call: one answer, one usage record, paid once.
- `circuitBreakerPolicy: { failureThreshold, window, openFor, fallback? }`: that many failed calls
  within the window open the breaker for `openFor`; while open, calls go to the `fallback` provider
  (its base URL and key) or fail fast with `ModelCallError` `model.circuit-open`. Shared per
  provider in the process (across processes after #121).
- Timeouts and retries are the provider's — LangChain's own retries are off.

## Fail fast: settings must fit their models

At **every startup** (with the production gateway) and with **`agboss check --models`** ([CLI](CLI),
part of `make check` for job-scout — every model of **every workflow of the application** the
workflow is in, each key prefixed with its workflow when there are several), every model use is checked against what its provider says the
model supports (OpenRouter: its public model list — parameters, reasoning efforts, mandatory
reasoning, cache pricing; Jev: its known models). **All problems at once**, each with the setting's
key, the value, the model and what the model supports:

```
ConfigurationError: 2 model setting(s) do not fit their models
  model.unsupported-setting  agents.scout-agent.thinking = on(effort high, budget 4000 tokens) — model moonshotai/kimi-k2.6: efforts minimal, low, medium, high, xhigh; budget yes; effort with budget no
  model.unknown-model  routers.main = typesafe/jev-1.4 — model typesafe/jev-1.4: jev does not list it
```

Codes: `model.unsupported-setting` (reasoning form, cache retention or parts, `temperature`,
`max_tokens`), `model.unknown-model`, `model.no-price`, `model.unserved`,
`model.ambiguous-provider` (the last two also fail the assembly, above). **Nothing is substituted** — not the nearest effort, not the nearest
retention, not "budget instead of both". Caching "where supported" on a model without caching is
simply none.

The startup log (`app.models`, printed by `agboss chat`) shows each use's provider, reasoning and
caching — `(inherited from <provider>)` when the component sets none — and the cost source.

## Wire form

`toWireRequest` is the one place a request body is finalised: the provider's request fields, the
reasoning and caching fields in its dialect, cache markers, tools sorted by name (their JSON Schemas
without `$schema`). Jev routes and LLM-router options are sent sorted by name too, and agent and
router prompts are normalised at load (BOM, edge blank lines, NFC) and sent as loaded — declaration
order and file encoding change neither the request nor its fingerprint (#125).

## Tests

Tests never reach a provider: `testWith` scripts every model ([Testing](Testing)); a scripted answer
on a model without a price reports its cost the way a provider would. Provider code is tested with a
stub `fetch` (`createAppDeps(bundle, { providerFetch })`).
