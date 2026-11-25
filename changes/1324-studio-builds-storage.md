---
section: Fixed
issue: 1324
---

**`studioOf` builds the application's storage as `createApp` does** (#1324): `studioOf`, and the standalone `createAppDeps` (eval, replay, golden, compare), created a workflow's components outside the application's container, so a repository on `SqliteConnection` failed with "the SQLite implementations need sqlitePath" for an application on `@DatabaseStorage(SqliteDriver)`. Its components now share the container the storage's settings are in, read from the given `processEnv`. No migration.
