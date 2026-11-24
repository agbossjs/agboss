---
section: Breaking
issue: 1280
---

**`.forEachItem(step, { maxItems | takeFirst, maxConcurrency })`** (#1280). One run of `toAgent(A)`,
`toAction(X)`, `toExternalTask(Q)` or `toWorkflow(W)` per item of the list the step before gives, with
the same `.onError(E, skip())` as `.inParallel([…])`. Exactly one bound: `takeFirst` launches the first
N items and the rest are dropped, recorded (`LaunchItemsTruncatedEvent.takeFirst`, no error);
`maxItems` is strict — a longer list throws `LimitError.Items` before any branch starts (the
producer's list is already in the scope), taken by the join's `.onError(LimitError.Items | LimitError
| AGBossError, …)`, which is required: `[launch.max-items-handler-required]` and, in types,
`NeedsItemsHandler` (the path is not a path until a handler covers the limit). New:
`forEachItem(step, options)` starter, `ForEachItemOptions`, `TakeFirstOptions`, `MaxItemsOptions`,
`ItemsLaunched`, `NeedsItemsHandler`, `ForEachItemStep`, `itemBoundOf`; `LaunchItemsTruncatedEvent.maxItems`
is `takeFirst`. Not removed yet (F1): per-item `.toParallel…(…)`, `maxItems` of it (a slice, like `takeFirst`).
