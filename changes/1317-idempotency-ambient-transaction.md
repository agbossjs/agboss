---
section: Breaking
issue: 1317
---

**`runOnce`'s `execute` is handed no transaction; SQLite's is asynchronous** (#1317, part c) — a repository
writes through its connection's `requireTransaction()`, a guarded handle that rolls back with the effect on
any uncaught error, identically on SQLite, PostgreSQL and MongoDB. `execute: () => …` (the 0.1.0
`(db: DatabaseSync) => …` and `InMemoryFencedEffectTransaction.onCommit` are gone), and
`FencedEffectRepository` and `FencedEffectWork` lose their transaction type parameter.

- **SQLite:** every `Sqlite*Repository` operation goes through one per-file priority mutex on the shared synchronous
  connection. A `runOnce` holds its `BEGIN IMMEDIATE … COMMIT` span (capped at 15 s, `SQLITE_HOLD_CAP`;
  past it the attempt rolls back with `IdempotencyError.HoldTooLong`) while every other operation waits behind it and
  never lands inside it; a lease renewal is served ahead, so a long `runOnce` never loses its own lease. A
  statement that throws through the handle poisons it (`IdempotencyError.TransactionPoisoned`: later statements
  are refused and the transaction rolls back, never commits); a handle kept past its attempt is dead
  (`IdempotencyError.OutsideTransaction`); `connection.transaction()` inside a `runOnce` is
  `IdempotencyError.NestedTransaction`.
- **Removed:** `SyncWorkRequiredError` (`fenced-effect.sync-work-required`), `InMemoryFencedEffectTransaction`,
  `executionContext.fence` (the framework and its tests read the fence internally; `ExecutionFence` stays a
  type of `@agboss/core/stores`, its `fencedError()` now returns `ExecutionError.Fenced`).
- **Added:** `SqliteConnection.requireTransaction()`, `SqliteTransactionHandle` (and its statement and run
  types) and `SQLITE_HOLD_CAP` in `@agboss/core/stores`; `IdempotencyError.NestedTransaction`,
  `TransactionPoisoned`, `HoldTooLong`.
- **Stores:** a store's `runInTransaction(key, work)` calls `work()` with no argument inside its own ambient
  transaction; its connection exposes `requireTransaction()` (guarded wrapper, `closed` in `finally`, poisoned
  by any rejected query: `25P02` on PostgreSQL, `client.release(true)` when a query is in flight at the timeout).
  The contract's `FencedEffectBusinessRows.insert(row)` takes no transaction.
