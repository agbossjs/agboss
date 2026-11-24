---
section: Breaking
issue: 1321
---

**`@DatabaseStorage`, `@ClusterStorage` and `@ObjectStorage` with `*Driver` factories** (#1321, #1324): `@Application({ storage })` takes
`storage: AppDatabaseStorage` or `storage: { database, cluster?, objects? }` — storage components that hold the driver (`SqliteDriver({ path })`,
`SqliteDriver.inMemory()`, `S3Driver`, `LocalDiskDriver`, `InMemoryObjectDriver()`; the store packages bring `PostgresDriver`, `MongoDriver`,
`RedisDriver` with `defineStorageDriver` from `@agboss/core/stores`) with `env(…)` / `secret(…)` references read once when the application
starts. The stores come from the drivers, so a store class listed in `providers` beside `storage` is `[storage.providers-conflict]`; with a
cluster the leases, the child queue and the rate limits go to it and its lease keeps its execution ids in the database's lease row.
`@DatabaseStorage({ auditLogTtl, ledgerEntriesTtl })` (required; `Ttl.Forever` never swept, `Ttl.None` for the audit log swept at the next look)
replaces `retention.auditLog` and `retention.costLedgerEntries` (`[storage.retention-conflict]` when both are set); `idempotencySecret`,
`previousIdempotencySecret` and `piiSecret` replace the key fields. `InMemoryDatabaseStorage` is the built-in in-memory database. `SqliteConnection`
moved from the root to `@agboss/core/stores`. `agboss describe` lists each storage component.
