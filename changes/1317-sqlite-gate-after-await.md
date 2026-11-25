---
section: Fixed
issue: 1317
---

**A SQLite repository's statements after an `await` wait for an open `runOnce` too** (#1317, bug hunt 2026-11-25
finding 1) — the file's gate covered a repository method only up to its first `await`, so a statement after it
could run while another run's `runOnce` held the transaction and failed with an "unreachable" error that was not
retried: the gateway charged, `markCompleted` threw, the intent stayed Pending and the run failed. The outbound
call's `markPending` / `markCompleted` / `markFailed` / `leaseStateOf`, `claimExecutionId`, the checkpoint
saver's `put` / `putWrites` / `getTuple` / `list` / `latestByStep`, the audit log's `deleteExpired` and the idle-thread
sweep now run each group of statements after an await through `connection.serve(…)`, queued behind the hold and
retried on another process's lock. A statement of a repository operation that runs after one of its awaits outside
`connection.serve` now fails at once, every time, instead of only when a hold opens in the gap. No migration.
