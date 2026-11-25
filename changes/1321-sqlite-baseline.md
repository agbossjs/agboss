---
section: Breaking
issue: 1321
---

**The SQLite schema is one 0.1.1 baseline, created when the connection opens** (#1321c): `SqliteConnection` runs every store's DDL at open — one transaction, all `CREATE … IF NOT EXISTS`, no store creates a table of its own — and the schema version in `agboss_schema` is reset to `100` (above every number an earlier build wrote: `1`, `2`). The migration steps for files 0.1.0 wrote are gone (the lease and fenced-effect columns, the pauses' rebuilds, `execution_cancel_requests`, the checkpoints' stored `step`, the Turn tables' sixteen migrations squashed into one): a file that predates the baseline — one with agboss tables and no stamp, or an older stamp — is refused at open with `StoreError.SchemaMissing` (`store.schema-missing`) and must be recreated; only a file with no table of the baseline is stamped. `SqliteConnection.addColumn` and `uniqueIndexesOf` are removed; `ensureSchema` stays for an application's own tables.
