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
- **Still there (until F2):** `@Agent({ price })`, `RetryPolicy.none()`, `routeTo`.
