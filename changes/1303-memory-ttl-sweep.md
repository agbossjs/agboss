---
section: Breaking
issue: 1303
---

**`@Memory({ ttl })` is swept, and compaction honours token budgets** (#1303c): the recovery sweep removes the threads of a workflow idle for longer than its memory's `ttl` (counted from the thread's last activity, a record written or completed; `Ttl.Forever` and a workflow with no `memory` are never swept) with their records, summaries, owners and pause answers, and never a thread of a live or paused tree. New on `ExecutionRecordRepository`: `deleteIdleThreads(cutoffs, isEnded): Promise<number>` (cutoffs by workflow name; a store implements it, the contract has the cases). `CompactionRun` (what a compaction sees of the run) has `budgetLeftTokens`, the tokens the token budgets leave (`undefined` without one): a compaction with none left is skipped, as one with no USD left is.
