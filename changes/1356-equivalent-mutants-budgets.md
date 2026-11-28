---
section: Changed
issue: 1356
---

**The last equivalent mutants of the budget and `@Rag` shards are gone by rewrite** (#1356): `budgetOf` and `overlaidBudget` answer a missing class as they answer a class that is no budget, so the budget a workflow attaches is read in one expression (`overlaidAttachedOf`) with no `=== undefined` branch beside it, and the `@Rag` classes a tool injects are found by `componentOf` alone. Behaviour is unchanged. No migration.
