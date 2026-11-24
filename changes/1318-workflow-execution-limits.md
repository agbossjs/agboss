---
section: Breaking
issue: 1318
---

**`@Workflow({ historyTtl, executionLimits })`** (#1318, part 1318c-dsl).

- `@Workflow({ executionLimits: { maxSteps, maxDepth, maxPathDepth, maxConcurrency } })` groups the workflow's count limits.
  `WorkflowExecutionLimits` is the new type; `@Workflow({ historyTtl })` (a duration, `Ttl.Forever` or `Ttl.None`) is the new option,
  checked by `[limits.history-ttl-invalid]`.
- Removed: the flat `maxSteps`, `maxDepth` and `maxConcurrentExecutions` of `@Workflow` (`maxConcurrentExecutions` is
  `executionLimits.maxConcurrency` now) and `defaults.flow.maxPathDepth` (`FlowDefaults`; it is `executionLimits.maxPathDepth`).
  The old keys are no longer on the `@Workflow` allowlist, so `[decorator.unknown-option]` tells where each went:
  `move it into executionLimits: { maxSteps: … }`, and for the renamed one `{ maxConcurrency: … }`.
- Renamed with it: `describe`'s `DescribedLimits.maxConcurrentExecutions` / `isMaxConcurrentExecutionsSet` are `maxConcurrency` /
  `isMaxConcurrencySet`, and `WorstCaseLimits.maxConcurrentExecutions` is `maxConcurrency`. The rule codes are unchanged.
- Profiles: `workflows.<name>.executionLimits` (field by field) and `workflows.<name>.historyTtl` in a `defineConfig` /
  `.config.yaml` profile, also under `"*"`. One carrier (`ComponentOptions.executionLimitsOf`, `ComponentOptions.historyTtlOf`) is
  read by the run (steps, depth, the tree's concurrency cap, whether a finished tree's history is kept), the assembly rules, the
  worst case and `describe`, so a limit is the same on every path. The declared `@Workflow` is never changed.
- `historyTtl: Ttl.None` (declared or by profile) keeps no execution record of the workflow's trees. `historyTtl` is not yet
  mandatory, and a duration or `Ttl.Forever` does not yet set a per-workflow sweep: those are the F2 flip and 1318c-store.
