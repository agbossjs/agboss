---
section: Breaking
issue: 1313
---

**`PromptCaching.on`, `executionLimits`, cache prices, `decide`** (#1313): `PromptCaching.whereSupported({ … })` is `PromptCaching.on({ retention?, cachedParts?, key? })` (the defaults are five minutes and the system prompt, tools and history); an explicit `on` fails the startup check where the model cannot cache, a provider that sets none caches automatically. `@Agent({ maxVisits, maxToolCalls, maxRetries })` are `@Agent({ executionLimits: { maxVisits, maxModelCalls, maxToolCalls, maxRetries } })`, and `maxModelCalls` (default 12) is new. `ModelPrice.cachedInputPerMillion` is `cacheReadPerMillion`, with `cacheWritePerMillion` for tokens written to the cache. A provider's `decide(request: ModelProviderDecisionRequest)` answers a decision (`routeTo` stays until the flip).
