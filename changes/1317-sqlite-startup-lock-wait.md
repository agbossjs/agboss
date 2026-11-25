---
section: Fixed
issue: 1317
---

**A SQLite instance starting beside a writer waits for its lock** (#1317): the record store's
startup migration and `SqliteConnection.ensureSchema` ran with SQLite's `busy_timeout` at 0 once the
file was open, so an instance that started while another process held the write lock died with
`database is locked`. The synchronous startup work now waits for the lock for the 5 s busy window,
as the open does, and past it fails with `StoreError.LockTimeout` (nothing applied). No migration.
