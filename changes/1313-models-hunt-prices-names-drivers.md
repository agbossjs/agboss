---
section: Fixed
issue: 1313
---

**Every model use is priced by its own provider and model; two providers of one name and a driver's unknown option are refused at assembly** (#1313; bughunt 2026-11-25, findings 1, 2, 5 and 6) —

- **Prices.** Only agents, judges and compactions were priced by their provider's `ModelCost.fromPrices` table. A model router,
  a guardrail, an arbiter, a launch decider, a reply interpreter, a model reranker, a `detectWithModel` PII policy and the built-in
  file transcriber and redactor on a price-table provider failed every call with a `ConfigError.Component` — or, when an agent on
  another provider used a model of the same name, were billed at that agent's price. Each is now priced from the provider its
  cascade resolved, keyed by the provider and the model, never by the model's name alone; a provider with no `cost` makes its
  calls unpriced (0 USD, tokens counted) — the reranker now carries that mark too. A `DecisionModel` decision (and a decision
  router, judge, guardrail or arbiter) whose decisions provider reports no cost is priced by that provider's table. A router or
  reranker call the provider answered and no price accounts keeps its tokens (`CostSource.Unpriced`) on its failure instead of a
  0-token record, so a `Fallback` reranking and a failed router still count against token budgets.
- **`[model.duplicate-provider-name]`** (new rule code): two `@ModelProvider` classes among those a workflow reaches — listed,
  named by a component or a cascade level, a profile's, a breaker's fallback — with one `name`. A use resolves to its provider's
  name, so `modelProvider: ProviderB` sent the prompt to provider A's upstream with A's key. The provider directory also never
  picks one of two providers of a name.
- **A driver's unknown option** is `[decorator.unknown-option]` at assembly, under the provider that uses it:
  `OpenRouterDriver({ baseURL })` left `baseUrl` at its default, so the proxy's key and every prompt went to public openrouter.ai.
  `OpenAiCompatibleDriver`, `OpenRouterDriver` (and its `routing`) and `DecisionsDriver` each list the keys they take; a stray key
  is never kept in the driver's settings.
- **A model reranker** is resolved through the workflow's cascade resolver like every other model use: a profile's
  `modelProviders` overlay, its `ragRerankers` override and the levels' `defaults.models.model` reach it at assembly and at the call.

- **Existing project:** rename one of two providers that share a `name`; fix a misspelt driver option (`baseURL` → `baseUrl`,
  `apikey` → `apiKey`). `WorkflowServices.rerankModel` takes the reranker's resolved model use (`{ name, model, modelProvider?, unpriced? }`).
