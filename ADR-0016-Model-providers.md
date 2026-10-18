# ADR-0016 — Model providers as components, settings checked against models at startup

- **Status:** Accepted
- **Issue:** #151 (parent #119, decisions of #112, #113, #115)

## Context

Models came from one hard-wired OpenRouter factory and a Jev client; timeouts and retries were
LangChain's (`timeoutMs`, `maxRetries`, #95), OpenRouter's `provider` preferences, `thinking` and
`cache` lived in the config of every component, and every chat model needed a hand-copied `price`.
A second provider (a local server, a backup) was impossible, a setting a model does not take was
discovered at the first call (or silently ignored), and the request body was assembled in several
places — nothing a fingerprint (#125) could hash.

## Decision

- **Providers are components**: `@ModelProvider({ name, serves, baseUrl, apiKey, timeout, cost,
  reasoning, promptCaching, retryPolicy, circuitBreakerPolicy })` classes, registered with
  `settings().modelProviders([...])` (since #266: listed in `@Application({ providers })` — a
  workflow names models only; resolution has no override and no default provider); `OpenAiCompatibleProvider<Fields>` with a typed
  `requestFields` member, `OpenRouterProvider`, `JevModelProvider`, own providers through
  `ModelProviderHandler`.
- **Resolution by `serves`**, per purpose (chat / decision): override wins, otherwise exactly one
  provider; none or several fail at startup.
- **Cost from the provider's answer, a price table as the fallback** (`ModelCost.fromResponse()` /
  `fromPrices`); a call that cannot be priced fails.
- **Reasoning and caching are the provider's, components may override**; typed values
  (`Reasoning.*`, `PromptCaching.*`), closed sets as enums.
- **Typed retry and circuit-breaker policies** in the provider's HTTP client; `Retry-After` honoured;
  an open breaker goes to the fallback or fails fast (`model.circuit-open`).
- **Fail fast, no silent substitution**: every setting is checked against the provider's
  capabilities at every startup and in `agboss check --models` (in CI), all problems at once.
- **One wire form** (`toWireRequest`): provider fields, dialects, cache markers, canonical (by
  name) order of tools and routes.

## Consequences

- Config loses `timeoutMs`, `maxRetries`, `provider` preferences; `price` becomes optional;
  `defaults.chat.thinking` / `cache` become optional overrides.
- Startup (with the production gateway) and `make check` read the providers' model lists —
  OpenRouter's is public, no key needed; an outage of it fails the gate.
- A model a provider does not list cannot be used until the provider lists it (or a subclass
  declares it, e.g. Jev's `knownModels`).
- The breaker is per process until #121's `StateRepository`; decorator fields for overrides arrive
  with #152; fingerprints (#125) hash the wire form.
