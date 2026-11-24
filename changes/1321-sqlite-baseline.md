---
section: Breaking
issue: 1321
---

**The SQLite schema is one 0.1.1 baseline, created when the connection opens** (#1321c): `SqliteConnection` runs every store's DDL at open — one transaction, all `CREATE … IF NOT EXISTS`, no store creates a table of its own — and the schema version in `agboss_schema` is reset to `1`. The migration steps for files 0.1.0 wrote are gone (the lease and fenced-effect columns, the pauses' rebuilds, `execution_cancel_requests`, the checkpoints' stored `step`, the Turn tables' sixteen migrations squashed into one): a 0.1.0 file is not read or migrated. `SqliteConnection.addColumn` and `uniqueIndexesOf` are removed; `ensureSchema` stays for an application's own tables.
