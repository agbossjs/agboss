---
section: Breaking
issue: 1313
---

**`@Agent({ price })` and the `Price` type are removed; a model's price is its provider's table** (#1313): `price` is gone from `AgentOptions`, from the config's agent and model settings (`ModelSettings`, `AgentSettings`, `defaults.models`) and from the profiles, and `Price` (`inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWritePerMTok`) is gone from `@agboss/core/models`. The one price shape is `ModelPrice` (`inputPerMillion`, `outputPerMillion`, `cacheReadPerMillion?`, `cacheWritePerMillion?`, each a `Usd`), read from the `@ModelProvider`'s `ModelCost.fromPrices(…)`; `ResolvedModelSettings.price` is a `ModelPrice`. The reported cost still comes first, then the provider's table; a model the table does not list is `[model.no-price]`. A price a component set on its own is set on the provider that serves it.
