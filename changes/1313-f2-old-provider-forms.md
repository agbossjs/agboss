---
section: Breaking
issue: 1313
---

**F2: the 0.1.0 model-provider forms are removed** (#1313, hard break) — a `@ModelProvider` is a driver (`OpenAiCompatibleDriver`, `OpenRouterDriver`, `DecisionsDriver`) or a transport class with `complete(request)`, and a component reaches it through `modelProvider` (its own, its workflow's or its application's), never by a regex over the model's name.

- **Removed:** `OpenAiCompatibleProvider`, `OpenRouterProvider`, `OpenRouterModelProvider`, `DecisionsModelProvider`, `JevModelProvider`, `DEFAULT_MODEL_PROVIDERS` (an application that lists no provider has none), `HttpModelProviderOptions` / `HttpModelProviderType`, `serves`, `baseUrl`, `baseUrlField` and `apiKey` on `@ModelProvider`, `ModelProviderHandler.chat` and `.routeTo`, `DecideRequest`, `ChatRequest`, `ProviderConnection`, `NoRequestFields`, `CachingRequest`, `OpenRouterFields`, `OPENROUTER_BASE_URL`, `isDecisionModel` (and the model-name families that told a decision model: the kind is the provider's driver), the rules and codes `[model.unserved]`, `[model.ambiguous-provider]`, `[model-provider.request-fields-missing]` and `model.fallback-unmapped`, and the catch-all provider yielding.
- **Changed:** a transport provider takes `model` / `models` like a driver one (role aliases); `ModelProviderDecisionRequest` has no `connection`; a model use whose cascade names no provider is `[model.missing-provider]`; a custom provider class that only implements `decide` is a decisions provider; `isSameProvider` (redaction values) compares drivers by dialect, base URL, key variable and headers; the transport snapshot of `configHash` holds `model` / `models` in place of `serves`.
- **Store follow-up:** none.
