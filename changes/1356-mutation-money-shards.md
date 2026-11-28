---
section: Changed
issue: 1356
---

**The mutation shards of money, budgets and the ledger are killed by real tests** (#1356): the `rate-limits`, `ledger-branch`, `ledger-memory`, `money-runtime`, `money`, `budget-reply`, `ledger-run` and `budget-loop` shards now catch every mutant of their files with a test that asserts the exact value, error class and message — the rate limit policy's balancing and weight rules, a branch's entries and spend when its arbiter fails it, a compaction's mid-way spend, a visit's limits and side path, an execution's budgets, a ledger entry's token checks, a reply interpreter's settings, a finished run's stop mark, and the preparing of a move's tool calls. No behaviour changes; the rewrites that removed equivalent mutants (a tokens-left check without a guard, one parse of a call's arguments, a reply observer that returns after the lookup) behave as before. No migration.
