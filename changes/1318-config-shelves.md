---
section: Breaking
issue: 1318
---

**The instance's limits are `@Application({ executionLimits })`, and a profile has shelves** (#1318, part 1318c).

- `@Application({ executionLimits: { maxConcurrentSteps, shutdownTimeout, compensationTimeout } })` joins
  `childClaimTimeout`; the flat `maxConcurrentSteps`, `shutdownTimeout` and `compensationTimeout` options are
  gone (the checks `[limits.max-concurrent-steps-invalid]` and `[limits.timeout-invalid]` name the nested
  field). `agboss describe` and `describe --json` print `maxConcurrentSteps` as before.
- The stored config key `compactions` is `memories` (`AgentsConfig.memories`, `ModelUse` keys `memories.<name>`,
  the resume hash input, eval's prompt diff); a profile's workflow overlay says `memories`, not `compactions`.
  A workflow overlay no longer has `defaults` (chat defaults are the profile's own `defaults`, for every workflow)
  and gets `routers: { "<node>": { model, modelProvider } }`.
- `defineConfig` / `.config.yaml` shelves: `budgets: { "<budget name>": { maxSpend, maxTokens } }` (a constant, or
  a `defineEnv` value in a `.config.ts`) and the model of a component, `judges`, `arbiters`, `guardrails`,
  `piiPolicies`, `channelInterpreters`: `{ model, modelProvider }` (the provider by its `name`, or its class in a
  `.config.ts`). A budget overlay reaches every reader of the budget — the listing, the workflow's attached
  budget, the execution's checks, the ledger limits, `describe` — through one derived class; the declared class
  is never changed. A name no component has, a budget that reads its limits in `limit()`, a provider that does not
  reach the workflow: a `ProfileError` naming the key.
