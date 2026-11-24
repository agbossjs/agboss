---
section: Breaking
issue: 1313
---

**`[decorator.unknown-option]`: an option a decorator does not take fails assembly** (#1313, #1318, #1324):
a key that is not on a framework decorator's list — a typo, a key behind a spread or an untyped
variable, or a key from JavaScript, which TypeScript does not check — used to be ignored, so a
`maxToolCalls: 2` on `@Agent` was replaced by the default 20 and a `guardrail` (for `guardrails`) or
`piiPolicy` (for `piiPolicies`) guarded nothing. Every framework decorator (`@Application`, `@Workflow`,
`@Agent`, `@Action`, `@Router`, `@Tool`, `@Judge`, `@Arbiter`, `@Memory`, `@Rag`, `@Budget`,
`@ModelProvider`, the storages, the pause targets and channels, …) and the nested `executionLimits` and
`defaults` bags now refuse any key with a value other than `undefined` that is not on its list. The message
names the option and the decorator, never the value, and suggests the nearest option or the key's new
place (`maxToolCalls`, `maxVisits`, `maxRetries` of `@Agent` belong in `executionLimits`). Each list is
held equal to its options type by the compiler. Migration: fix what the message names.
