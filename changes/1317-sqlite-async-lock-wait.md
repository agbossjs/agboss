---
section: Breaking
issue: 1317
---

**SQLite waits for another process's lock asynchronously** (#1317c, money review finding 4) — a `runOnce` of one
instance holds `BEGIN IMMEDIATE` for up to 15 s (`SQLITE_HOLD_CAP`), and SQLite's own busy wait (5 s, synchronous)
used to block the event loop of every other instance on the file and then fail its lease renewals, checkpoints,
fenced effects and the operator's cancel/pause with "database is locked". Now `busy_timeout` is 0 once the
connection is open, and a busy answer is tried again asynchronously with a jittered growing pause, up to 20 s
(the hold cap and 5 s); the event loop never blocks, a renewal that waits through a whole hold lands before the
30 s lease lapses, and past the deadline the call fails with the new `StoreError.LockTimeout`
(`store.lock-timeout`; nothing was applied, a retry is safe). Fencing is unchanged: the waiting call runs once,
after the holder's commit. A wait that would not fit the lease (hold cap or deadline) fails start with
`ConfigError.Option`.

- **Behavior:** `connection.transaction()` called directly (outside a repository operation) no longer waits for
  another process's lock; run it through `connection.serve(() => …)`. `PRAGMA busy_timeout` of an open
  connection is 0.
- **Added:** `StoreError.LockTimeout` / `StoreErrorKind.LockTimeout`.
