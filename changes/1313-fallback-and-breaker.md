---
section: Breaking
issue: 1313
---

**`fallback` is a provider's option, and the breaker is half-open** (#1313c): `@ModelProvider({ fallback })`
takes a provider class or `{ provider, models }` and chains (`A → B → C`); it answers an open breaker
and a call that failed after its retries (a timeout, a 429, a 5xx, a broken connection, a refused key, an
unknown model, a used-up quota) — never a caller's cancel, an input the model cannot take, or a request
refused as wrong. The call is recorded once, under the provider that answered. `CircuitBreakerPolicy` is
`CircuitBreakerPolicy.fixed({ failureThreshold, failureWindow, openDuration, halfOpenProbes? })` or
`.exponential({ …, initialOpenDuration, maxOpenDuration, jitter })`: after an open `halfOpenProbes` calls try
the provider, a success closes it, a failure opens it again; its state stays in `RateLimitRepository`
(no store change). An error answer (401, 403, 404) is no success of the breaker. Readiness reports an open
or half-open breaker `Degraded`.

Removed: the `{ failureThreshold, window, openFor }` literal, `CircuitBreakerPolicy.fallback` and
`.fallbackModels`, and the public `CircuitBreaker` and `CircuitBreakerStore`. Added: `CircuitBreakerPolicy`
(value), `CircuitBreakerPolicyError`, `BreakerBackoff`, `ModelFallback`, the rules
`[model-provider.fallback-cycle]` and `[model.incompatible-fallback-provider]`.
