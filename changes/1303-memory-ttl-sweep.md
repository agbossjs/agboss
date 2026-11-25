---
section: Breaking
issue: 1303
---

**`@Memory({ ttl })` is swept, and compaction honours token budgets** (#1303c): the recovery sweep removes the threads of a workflow idle for longer than its memory's `ttl` (counted from the thread's last activity, a record written or completed; `Ttl.Forever` and a workflow with no `memory` are never swept) and empties them of records, summaries and pause answers, never a thread of a live or paused tree. A swept thread that has an owner stays as a tombstone (its row and owner, marked swept): another owner asking for the id is refused at the owner check, the same owner restarts on an empty thread; a thread with no owner goes whole. New on `ExecutionRecordRepository`: `deleteIdleThreads(cutoffs, isEnded): Promise<number>` (cutoffs by workflow name; a store implements it, the contract has the cases). `CompactionRun` (what a compaction sees of the run) has `budgetLeftTokens`, the tokens the token budgets leave (`undefined` without one): a compaction with none left is skipped, as one with no USD left is.
