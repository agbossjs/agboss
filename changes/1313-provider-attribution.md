---
section: Breaking
issue: 1313
---

**Providers attribute every call** (#1313): `provider` is required on `UsageRecord`, `CostLine`, `ModelStartEvent`, `ModelEndEvent` and `EvalModelCallTrace` (`(none)` for a charge no model provider made, a tool's for one). A `@ModelProvider` that sets no `promptCaching` caches automatically (the system prompt, tools and history at `FiveMinutes` where the model supports it, silently none where not) instead of `PromptCaching.off()`. `CliModelProvider`: the hook `invocationOf` is `buildCommand`; `CliInvocation.inheritEnvironment` is removed — a CLI gets the safe allowlist of the environment plus the `env` the invocation names.
