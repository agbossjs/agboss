---
section: Changed
issue: 1356
---

**More mutation shards of money, budgets and the ledger are killed by real tests** (#1356): the `budget-flow`, `spend`, `ledger-retention` and the files of `stream` that account for a call that failed mid-way (#1399) now catch their mutants with tests that assert exact amounts, records, messages and error fields — the arbiters of a branch and the visit's interrupt bounds, a profile's overlay of budgets and the rules of attached budgets, a budget's limits and the cap a spend has reached, the cost report, the idle-thread sweep and the audit rows that go with it, a `@Rag`'s scope and reranker, and the spend of a stream that was cut. Equivalent mutants were removed by rewrites that behave as before (one lookup instead of two for an arbiter, an absent cap read as `Infinity`, an absent list read with `?.`, the carriers of a failed call's spend following its causes without an object check). No migration.
