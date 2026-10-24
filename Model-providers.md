# Model providers

Every model a workflow uses — an agent's, compaction's, a router's, a guardrail's, a judge's — comes
from a **model provider**: an `@ModelProvider` class from `agboss/models`. The provider says which
models it serves, how it is reached (base URL, key, timeout), what a call costs, how its models
reason and cache by default, how many calls it takes (rate limit) and what happens when a call
fails (retry policy, circuit breaker).
Introduced in #151 ([ADR-0016](ADR-0016-Model-providers)); since #266 model providers are
**application infrastructure**: listed in `@Application({ providers })`, shared by every workflow
of the application — a workflow and its components name models only and never pick a provider.

## A provider

```ts file=src/model-providers/openrouter.model-provider.ts
import {
  CachedPart, CacheRetention, ModelCost, ModelFailure, ModelProvider, OpenRouterProvider,
  PromptCaching, ProviderSort, QueueBalancingStrategy, RateLimitPolicy, Reasoning, RetryPolicy,
  type OpenRouterFields,
} from "agboss/models";
import { minutes, seconds } from "agboss/units";

@ModelProvider({
  name: "openrouter-model-provider",                    // kebab-case, ends with -model-provider
  description: "OpenRouter — many models behind one OpenAI-compatible API",
  serves: [/.*/],                                       // which model names it serves
  baseUrl: "https://openrouter.ai/api/v1",              // the default…
  baseUrlField: "openRouterBaseUrl",                    // …unless this text field of the environment sets one
  apiKey: "openRouterApiKey",                           // a Secret field of the application's environment
  timeout: minutes(2),                                  // per attempt, from the moment it has room
  cost: ModelCost.fromResponse(),                       // OpenRouter returns usage.cost
  reasoning: Reasoning.modelDecides(),                  // required here; components may override
  promptCaching: PromptCaching.whereSupported({         // required here; components may override
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
  }),
  retryPolicy: RetryPolicy.exponential({                // retries one call: the only backoff
    maxAttempts: 3, initialDelay: seconds(1), maxDelay: seconds(20), jitter: true,
    retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
  }),
  rateLimitPolicy: RateLimitPolicy.of({                 // one limit for the whole application
    maxConcurrentCalls: 8,
    perMinute: { calls: 120, tokens: 400_000 },
    balancing: QueueBalancingStrategy.TenantRoundRobin, // the default
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

### Pinning the host and the precision (#395)

`OpenRouterRouting` is OpenRouter's `provider` field in camelCase — `order`, `only`, `ignore`
(hosts by OpenRouter's slug: `fireworks`, `together`), `sort`, `quantizations` (`Quantization.Int4`,
`Int8`, `Fp4`, `Fp6`, `Fp8`, `Fp16`, `Bf16`, `Fp32`, `Unknown`) and `allowFallbacks`. The TypeScript
API is camelCase everywhere; only the body sent to OpenRouter is snake_case (`allow_fallbacks`), so
`allow_fallbacks` in `requestFields` does not compile. Pin a host and a precision when answers must
not drift between upstreams — an eval, a benchmark, a cassette recorded once:

<!-- snippet-context
import { ModelCost, ModelProvider, OpenRouterProvider, PromptCaching, Quantization, Reasoning, RetryPolicy, type OpenRouterFields } from "agboss/models";
import { minutes, seconds } from "agboss/units";
-->

```ts
@ModelProvider({
  name: "pinned-openrouter-model-provider",
  description: "Kimi on Fireworks at bf16, no fallback",
  serves: [/^moonshotai\//],
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class PinnedOpenRouterModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {
    provider: { only: ["fireworks"], quantizations: [Quantization.Bf16], allowFallbacks: false },
  };
}
```

Every call's `UsageRecord.servedBy` names the host that served it — OpenRouter's `provider` of the
answer, plain or streamed (absent when a provider does not say). `agboss check --models` asks
OpenRouter for each served model's endpoints (`GET /models/<model>/endpoints`) and reports
`[model.no-matching-endpoint]` for a pinned host (`only`) that does not serve the model, and for
pinned `quantizations` no allowed host (in `only`, not in `ignore`) serves it at; the endpoints are
never asked at startup.

## A custom transport: `complete(request)` (#385)

A provider that is not an OpenAI-compatible HTTP server — AWS Bedrock through its SDK, Vertex AI, a
corporate gateway with its own authorisation — `implements ModelProviderHandler` with
`complete(request)` instead of `baseUrl` / `baseUrlField` / `apiKey`, and takes its services through
`deps`:

```ts file=src/model-providers/bedrock.model-provider.ts
import { Injectable, TenantContext } from "agboss";
import {
  ModelCost, ModelFailure, ModelProvider, ModelProviderFailureError, QueueBalancingStrategy,
  RateLimitPolicy, RetryPolicy, TRANSIENT_FAILURES,
  type ModelProviderHandler, type ModelProviderMessage, type ModelProviderRequest,
  type ModelProviderResponse, type ModelProviderToolDefinition,
} from "agboss/models";
import { minutes, seconds, usd } from "agboss/units";

/** What the SDK takes: the framework's plain messages and tools, the tenant, the call's signal. */
export interface BedrockInvocation {
  readonly model: string;
  readonly messages: readonly ModelProviderMessage[];
  readonly tools: readonly ModelProviderToolDefinition[];
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

@Injectable()
export class BedrockSdkClient {
  async invoke(invocation: BedrockInvocation): Promise<ModelProviderResponse> {
    const response = await fetch(`https://bedrock.internal/${invocation.model}`, {
      method: "POST", body: JSON.stringify(invocation), signal: invocation.signal,
    });
    if (response.status === 429) {
      const retryAfter = seconds(Number(response.headers.get("retry-after") ?? "1"));
      throw new ModelProviderFailureError(ModelFailure.RateLimited, { retryAfter });
    }
    return (await response.json()) as ModelProviderResponse; // { text, toolCalls?, usage, cost? }
  }
}

@ModelProvider({
  name: "bedrock-model-provider",
  description: "AWS Bedrock through its SDK",
  serves: [/^bedrock\//],
  timeout: minutes(2),                                  // per attempt: request.signal aborts at it
  cost: ModelCost.fromPrices({
    "bedrock/claude": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8,
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3, initialDelay: seconds(1), maxDelay: seconds(20), jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
  deps: [BedrockSdkClient, TenantContext],              // reasoning / promptCaching unset: off
})
export class BedrockModelProvider implements ModelProviderHandler {
  constructor(
    private readonly bedrockSdkClient: BedrockSdkClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.bedrockSdkClient.invoke({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tenantId: this.tenantContext.tenantId,            // the execution of this call
      signal: request.signal,
    });
  }
}
```

- **One mode.** HTTP (`baseUrl`, `apiKey`, `baseUrlField`, a `chat` class) or a transport
  (`complete`, `deps`) — both at once do not compile (the decorator's overloads) and fail assembly
  with `[model-provider.both-modes]`; so does neither. `description`, `timeout`, `cost` and
  `retryPolicy` (`RetryPolicy.exponential(…)` and the others) are required as for HTTP;
  `reasoning` / `promptCaching` are optional — `Reasoning.off()` / `PromptCaching.off()` when unset.
- **Created by the application's container**, on its first call: one instance per application, its
  `deps` injected and checked at assembly with the components' (`Consumer: "TOKEN" is not
  registered …`). An injected `TenantContext` / `ExecutionContext` reads the execution of the call
  (`complete()` runs in the step's frame).
- **The request** — `ModelProviderRequest`: `model` (with a fallback, its `fallbackModels` entry),
  `messages` (`ModelProviderMessage { role: ModelProviderMessageRole.System | User | Assistant | Tool,
  text, toolCalls?, toolCallId? }` — text only, masked by the PII policies), `tools`
  (`ModelProviderToolDefinition { name, description, parameters }` — the agent's own tools and its
  `answer-<dto>` tools), `temperature`, `maxTokens` (`undefined` = `TokenLimit.MODEL_MAX`),
  `reasoning`, `promptCaching`, `signal` (the attempt's timeout, a cancel, an exhausted budget — an
  SDK that ignores it is cut at `timeout` anyway, as a `Timeout`). No LangChain type in the contract.
- **The answer** — `ModelProviderResponse`: `text`, `toolCalls?` (`ModelProviderToolCall { id, name,
  arguments }`), `usage` (`ModelProviderUsage { inputTokens, outputTokens, cacheReadTokens?,
  cacheWriteTokens? }`: the rate limit's tokens, the price table's), `cost?` (exact, `costSource:
  "api"`; absent → the decorator's price table), `finishReason?` (`FinishReason.Length`). An answer
  without `text` or `usage` is a `ModelProviderError`.
- **Failures** — throw `ModelProviderFailureError(ModelFailure.…, { retryAfter?, cause? })`
  (`model.provider-failure`): the retry policy retries the failures it lists, `RateLimited` pauses
  the provider's whole queue for `retryAfter` and halves the instance's concurrency, the breaker
  counts it. Any other error is not retried and is counted by the breaker.
- **Everything else is the gateway's**, unchanged: `serves`, the budgets before the call and
  `CostLedgerRepository` after it, the queue and its 429 pause, retries, the breaker (readiness
  `Degraded`) and its fallback — HTTP and transport either way —, PII masking and revealing, the
  answer tools of a DTO agent, traces, and `mockLlm` in `testWith`, which answers above the provider
  (`complete()` is never called by a scripted test). Inside, the transport is a `BaseChatModel`
  adapter and every provider's calls go through one attempt runner.
- **Its lifecycle** is a component's (#385 S4): created on its first call, its `onInit` →
  `onStart` (`implements OnInit, OnStart, OnStop, OnDestroy`) — and those of the dependencies
  created with it — run, awaited, before that call's `complete()`. Concurrent first calls share one
  creation, so the hooks run once. A failing hook fails that call with the same error a start gives
  (`[di.hook-failed] BedrockModelProvider.onStart failed: …`, the hook's error as `cause`); the
  next call tries again. At `app.close()` a created transport gets `onStop` and `onDestroy` in the
  usual order (dependants first); a transport never called gets no hook.
- **`capabilities(model, connection)`** is optional on a transport: given, it is checked at start
  like an HTTP provider's (the instance created for it); absent, its models' settings are not checked
  — `agboss check --models` never creates a transport.
- `agboss describe` prints `bedrock-model-provider → BedrockModelProvider (listed in @Application
  providers) · serves /^bedrock\// · transport: BedrockModelProvider.complete()` and each
  `model: bedrock/claude → bedrock-model-provider`; the transport providers (name, class, `serves`)
  are part of `configHash` — only where there is one.

## Register them in the application

`@ModelProvider` classes are listed **only** in `@Application({ providers })`, next to the rest of the
infrastructure ([App](App)). They are not created by the container (nothing injects a provider), and
one in a workflow's `providers` fails the application's assembly with
`[di.infrastructure-in-workflow] … is a @ModelProvider — infrastructure is listed only in
@Application({ providers })`.

```ts file=src/environments/app.environment.ts
import type { Secret } from "agboss";

/** The key both providers read (`apiKey: "openRouterApiKey"`); `test` leaves it out. */
export class AppEnvironment {
  openRouterApiKey?: Secret;
}
```

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
import { Application } from "agboss";
import { DecisionsModelProvider } from "agboss/models";
import { AppEnvironment } from "./environments/app.environment.js";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";

@Application({
  name: "job-scout-application",
  version: "1.0.0",
  environment: AppEnvironment,
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

### The key and the name

- **The key is a `Secret` of the application's environment** (#266 S73 c, [Environments](Environments)):
  `apiKey` names the field — `apiKey: "openRouterApiKey"` — and each environment that calls the
  provider sets it, `openRouterApiKey: secret("OPENROUTER_API_KEY")`; the built-ins read
  `openRouterApiKey`. It is read from `applicationContext.environment` when the app starts (a secret
  of an environment passed as written takes its own variable); a provider never reads `process.env`
  for it. A missing one fails the start of an app that calls the provider:
  `openrouter-model-provider reads its key from the application's environment: the environment has
  no openRouterApiKey — declare openRouterApiKey: Secret in the environment contract and set
  openRouterApiKey: secret("…") in each environment that calls it`. Tests script or replay models,
  so a `test` environment may leave the field out (declare it optional, `openRouterApiKey?: Secret`)
  and `agboss check` writes the types without a key (it reads the contract's shape); only
  `agboss check --models`, which connects, needs the secrets of the chosen environment.
- **The base URL** is `baseUrl`, unless `baseUrlField` names a text field of the environment that
  holds one — the built-ins read `openRouterBaseUrl` (a proxy or a local stub). The field is
  declared without a default, `openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")` with
  `openRouterBaseUrl?: string` in the contract: unset, it is `undefined` and the provider uses its
  decorator's `baseUrl` — the default is written once, in the decorator (#266 S87).
- **The name ends with `-model-provider`** (`[name.kind-suffix] "local" on @ModelProvider — name it
  "local-model-provider"`, at the application's assembly) — the built-ins are
  `openrouter-model-provider` and `decisions-model-provider`. The name keys the provider's shared
  state (its slots, windows, pause and breaker in `RateLimitRepository`) and appears in logs and
  `agboss describe`.

### Built in

| Class                               | What it is                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenAiCompatibleProvider<Fields>`  | any OpenAI-compatible server; `requestFields` is a typed member (`override readonly requestFields: Fields = { … }`) — a typo is a compile error. OpenAI's dialect: `reasoning_effort`, `prompt_cache_key`, `prompt_cache_retention`. |
| `OpenRouterProvider<Fields>`        | OpenRouter's dialect: `reasoning: { effort \| max_tokens, exclude }`, `usage: { include: true }` (the cost in every answer), `cache_control` markers for Anthropic and Google models, a model list that says what each model supports. `OpenRouterFields`: `provider` routing, `transforms`. |
| `OpenRouterModelProvider`           | the default chat provider (above, without request fields)                                                                                                                            |
| `DecisionsModelProvider`            | OpenRouter's Decisions API: serves the decision models (`DECISION_MODELS`: `typesafe/jev-*`, `openai/gpt-6-luna-decisions`, pplx-decider, Clef, …) for **decisions only** (routers, guardrails, decision judges); `JevModelProvider` is its deprecated alias |
| own provider                        | implement `ModelProviderHandler`: `chat?(request)` → a LangChain chat model, `routeTo?(request)`, `capabilities(model, connection)` (`undefined` = not served)                         |

## Which provider serves a model

- Exactly **one** listed provider must match the model name **for its purpose** — a chat model
  (agents, compaction, LLM routers, chat judges) needs a provider with `chat`, a decision (Jev and
  the other decision models: routers, guardrails, decision judges) one with decisions. So OpenRouter on
  `/.*/` and the decision models never clash.
- Checked for **every** model of the application at assembly — agents, model routers, the default
  router (`defaults.router.model`), guardrails, compaction and judges (arbiters and reply interpreters
  join when they exist, #267) — all at once, before any model call (`createApp`, `testWith`,
  `agboss check`):
  - none → `[model.unserved] job-scout-workflow agents.scout-agent = local/llama: no listed provider
    serves it for chat (listed: openrouter-model-provider, decisions-model-provider) — list a @ModelProvider that serves it in
    @Application({ providers })`;
  - several → `[model.ambiguous-provider] … served by several providers: local-model-provider, local-mirror-model-provider — one
    model string per provider, each in one serves`. No default breaks the tie: one model through
    two providers is two model strings, each in one provider's `serves`.
- **The built-ins yield** (#454): `OpenRouterModelProvider` and `DecisionsModelProvider` are
  catch-alls — listed (by default or by name), each serves its models **except** those another
  listed provider claims by `serves`. A project's provider for its own prefix (a transport serving
  `/^harness\//`, a local server on `/^local\//`) works next to them with no narrowed copy of the
  built-in: `harness/x` resolves to it, `moonshotai/kimi-k2.6` to OpenRouter. Only these two classes
  yield — a subclass with its own `@ModelProvider` claims what its `serves` says, like any other
  provider, and two such claims on one model stay `[model.ambiguous-provider]`. The key check at
  start does not change: a listed HTTP provider still needs its key.
- `agboss describe` prints the provider each model resolves to, though no component names it
  (`--json`: `models: [{ key, model, provider }]`):

```
models
  agents.scout-agent  model: moonshotai/kimi-k2.6 → openrouter-model-provider
  routers.main-router  model: typesafe/jev-1.13 → decisions-model-provider
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

## Retry, rate limit and circuit breaker

Three policies of a provider, each with one duty — all app-wide, since the provider is:

| Policy                 | Its duty                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `retryPolicy`          | retries **this** call: attempts and backoff — the only place backoff is set                  |
| `rateLimitPolicy`      | how many calls go to the provider, and how **everyone** slows down after a 429                |
| `circuitBreakerPolicy` | stops calling a provider that is down for a while (unchanged by #266, its state moved)        |

Next to them, `@Workflow({ maxConcurrentExecutions })` (#264) governs an execution tree's
structure and cost; `rateLimitPolicy` governs the provider API's capacity.

### `retryPolicy`

- `RetryPolicy.exponential({ maxAttempts, initialDelay, maxDelay, jitter, retryOn })` ·
  `RetryPolicy.fixed({ maxAttempts, delay, retryOn })` · `RetryPolicy.none()` — every field
  required, delays with units (`seconds()`, `minutes()`: a bare number does not compile). Only the
  listed `ModelFailure`s (`Timeout`, `RateLimited`, `ServerError`, `NetworkError`) are retried; a
  client error (4xx) is the answer. `jitter` makes each wait a random point of its upper half.
- `Retry-After` is honoured; one longer than the policy's longest wait (`maxDelay`, or `delay`) ends
  the retries with the provider's answer — never an early retry, never an unbounded wait.
- Retries are one call: one answer, one usage record, paid once. A wait between attempts **holds no
  `maxConcurrentCalls` slot**: the slot is released when an attempt ends and taken again before the
  next one, which queues on equal terms — a sleeping retry never blocks other executions.
- Timeouts and retries are the provider's — LangChain's own retries are off.

### `rateLimitPolicy`

`RateLimitPolicy.of({ maxConcurrentCalls?, perMinute?: { calls?, tokens? }, balancing? })` — at
least one limit, each a whole number ≥ 1; `RateLimitPolicyError` otherwise. **Without it there is
no limit**, as before #266.

- **One limit for the whole application**: every execution, tenant, parallel branch and instance
  shares it. Its state — the `maxConcurrentCalls` slots (leases, renewed while a call runs, free
  again after a minute if an instance dies), the per-minute windows and the pause after a 429 — is
  in the application's `RateLimitRepository` ([Several instances](Several-instances)): with
  `SqliteRateLimitRepository` (or your own over Redis) it holds on every instance at once.
- **A call without room waits**, in this order: the provider's tenant-fair queue → the pause → the
  per-minute tokens → a slot → the per-minute calls → the attempt's `timeout` starts → the call →
  its real usage counted → the slot released (when the answer has been read to its end). The wait
  is ended by the execution's signal — `app.cancel` (`ExecutionCancelledError`) or the caller's own
  `signal` — and the call never reaches the provider. Waiting never counts toward the attempt's
  `timeout`.
- **`perMinute`**: calls are counted when they start; tokens from the real usage after each call
  (`usage.total_tokens`), and a call starts only while the window's tokens are below the limit — calls
  already in flight may overshoot a little, like budgets.
- **Fairness (`balancing`, `QueueBalancingStrategy`)** — how a free slot is shared between the
  tenants waiting for one (every call has a `tenantId`, `"default"` in a single-tenant application):
  - `TenantRoundRobin` (default) — round-robin between waiting tenants, FIFO inside one: one tenant's
    50-item launch does not hold up another tenant's single call until the batch is done;
  - `TenantLeastInFlight` — the waiting tenant with the fewest calls in flight;
  - `TenantWeighted` — round-robin where a tenant gets up to its `weight` slots per round
    (`app.execute(Start, input, { tenant: { tenantId: "enterprise-corp", weight: 3 } })`, default 1);
  - `Fifo` — one queue in arrival order.

  Fairness is **per instance**: the queue is in-process, and between instances a slot goes to
  whoever takes the lease first. A cancelled waiter leaves its queue at once.
- **On a 429** the provider's **whole queue pauses** for `Retry-After` (else the retry policy's next
  delay) — on every instance, the pause being in `RateLimitRepository`; a later pause already set is
  kept. Then the instance that saw it **halves** its effective `maxConcurrentCalls` (at least one)
  and grows it back **by one a minute** without a 429 (AIMD — additive increase, multiplicative
  decrease; no setting, once per pause). The lowered level is per instance; the hard caps
  (`maxConcurrentCalls`, `perMinute`) are shared.
- Every wait, pause and AIMD step runs on the application's `Clock` — tests move them with
  `clock.advance(…)`.

**Recommended starting points** — set the limits from your provider plan's documented limits,
keeping some headroom (about 80 %) for other clients of the same key:

| Plan                                       | `maxConcurrentCalls` | `perMinute`                              |
| ------------------------------------------ | -------------------- | ---------------------------------------- |
| a free or trial key                        | 2                    | `{ calls: 20 }`                          |
| a small paid plan (requests per minute)    | 8                    | `{ calls: 120 }`                         |
| a plan with requests and tokens per minute | the plan's concurrency, else RPM ÷ 30 | `{ calls: RPM × 0.8, tokens: TPM × 0.8 }` |
| a local server (one GPU)                   | its batch size       | —                                        |

### `circuitBreakerPolicy`

- `{ failureThreshold, window, openFor, fallback?, fallbackModels? }`: that many failed calls
  within the window open the breaker for `openFor`; while open, calls go to the `fallback` provider's
  chat model (its own base URL, key and request fields — or its `complete()`, #385: HTTP and transport
  fall back to each other either way), each model as its `fallbackModels` entry, or fail fast with
  `ModelCallError` `model.circuit-open`.
- Its state — the failures in the window, the open breaker — is in the application's
  `RateLimitRepository` (#265 S52), so a breaker opened on one instance is open on every instance;
  its time is the application's `Clock` (no longer the system's, #262 S75 d).

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
  model.unknown-model  routers.main = typesafe/jev-1.4 — model typesafe/jev-1.4: decisions-model-provider does not list it
```

Codes: `model.unsupported-setting` (reasoning form, cache retention or parts, `temperature`,
`max_tokens`), `model.unknown-model`, `model.no-price`, `model.no-matching-endpoint` (`--models`
only: a pinned host or quantization, above), `model.unserved`,
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
stub `fetch` (`createAppDeps(bundle, { providerFetch })`). Scripted models answer above the
providers, so `rateLimitPolicy` and the breaker do not slow a `testWith` test down.
