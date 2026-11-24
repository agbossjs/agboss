---
section: Breaking
issue: 1313
---

**Driver model providers and the model cascade** (#1313, part a) — a `@ModelProvider({ driver })` is an independent class that speaks one protocol and holds its own model names; a component reaches it by `modelProvider`, not by a regex over the model's name.

- **Added:** `OpenAiCompatibleDriver`, `OpenRouterDriver`, `DecisionsDriver` and their option types; `@ModelProvider({ driver, model?, models? })`; `modelProvider?: Class` on `@Application`, `@Workflow` and `@Agent` (`Component → Workflow → Application`); roles through `models` (`model: "fast"`), and an `@Agent` with no `model` takes the provider's `models.default` or `model`; the rules `[model.missing-provider]`, `[model.incompatible-provider]` and `[model.missing]`.
- **Changed:** `ModelPurpose` is gone, `ModelKind` (`Chat`, `Decisions`) is the one enum, from `@agboss/core` and `@agboss/core/models`; what a model is follows its provider's driver, not its name, wherever the cascade names a provider; `@Agent({ model })` is optional; `ModelProviderDirectory.resolve` takes the cascade's provider; `ProviderConnection` carries a driver's resolved headers; the Decisions client sends no `Authorization` header without a key.
- **Still there (until every test application names its provider):** `DEFAULT_MODEL_PROVIDERS`, `serves` and the pre-decorated providers.
- **Fixed:** the provider rules (`[limits.timeout-invalid]`, `[model.price-invalid]`, the breaker, mode and request-field rules) run for every provider a cascade names — the application's, a workflow's, an agent's — not only the listed ones; `agboss describe` lists them (`DescribedModelProvider.isNamed`).

**Unpriced calls, `provider` on usage and cost, optional cost/retry/breaker** (#1313, part b)

- **Added:** `UsageRecord.provider?`, `CostLine.provider?` and `CostReport.byProvider` (what each `@ModelProvider`, by name, was paid); a provider with no `cost` makes its calls `CostSource.Unpriced` — 0 USD, the tokens recorded and counted against token budgets, never dropped (a call with no cost and no price on a provider that has a `cost` still fails closed); `FallbackMark.unpriced`; `ResolvedModelSettings.unpriced` (set by the cascade).
- **Changed:** `cost`, `retryPolicy` and `circuitBreakerPolicy` are optional on every `@ModelProvider` — omitted: unpriced, no retry, no breaker.
- **Removed:** the rule `[model-provider.circuit-breaker-required]` and `circuitBreakerPolicyOf`.
- **Still there (until F2):** `@Agent({ price })`, `routeTo`.

**`modelProvider` on every model-backed component, and the default model of the levels** (#1313, part c)

- **Added:** `modelProvider?: Class` on a model `@Router`, `@Arbiter`, `@InputGuardrail` / `@OutputGuardrail`, `@ReplyInterpreter` and a declarative `@PiiPolicy` (for its `detectWithModel`), resolved through `Component → Workflow → Application` like an agent's; `defaults.models.model` on `@Workflow` and `@Application`, the model of every component that names none (applies only when the component resolves to that level's provider); `ModelArbiterUse`, `LoadedRouter`, `LoadedModelGuardrail`, `PiiDetectorUse` and `AssembledReplyInterpreter` carry the resolved `modelProvider` and `unpriced`; an arbiter's and an interpreter's `model` is optional.
- **Changed:** a model component that names no model, with no provider in its cascade, is `[model.missing-provider]`; a provider only a component names is subject to the provider rules (timeout, price, breaker, mode) like a listed one.
- **Not here:** `@Memory` and `@RagReranker` take `modelProvider` with their own tickets (#1303, #1299).
