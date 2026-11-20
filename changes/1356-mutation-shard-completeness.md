---
section: Changed
issue: 1356
---

**Every file of `src/` is in a mutation shard or reviewed as not, and the spend modules are mutated** (#1356):
`tests/docs/mutation-shard-coverage.test.ts` fails a file of `packages/agboss/src` that no shard of
`stryker.config.mjs` mutates and that `tests/docs/non-sharded-src.ts` does not name with a reason. The new `spend`
shard mutates the usage record and its multiset key, the cost of a call and a service, the usage a checkpoint restores
and a response reports, a queued child's spend, the budget's rules, periods and deadline, and the run's budgets, at
100 %. No behaviour changes. No migration.
