# ADR-0034 — Schema upgrades stop the old version first

- **Status:** Accepted (#1104)
- **Issue:** #1104 (after #1103, #801, #847, #909, #936, #938)

## Context

The runbooks of the PostgreSQL and MongoDB stores told operators to run `migrate` as a Helm
`pre-upgrade` hook or an Argo CD `PreSync` Job, "before the pods roll out" — while every pod of the old
version is still running and taking traffic, and the rolling update then runs old and new pods
together. Several 0.1.1 migrations are not safe for that: a pause an old pod writes after the
migration has no `channel` and is invisible to a channel-filtered page; an old pod writes no pause
notice (#940) when it opens or closes a pause; the lease's `lease_epoch` became `token`, so an old
pod fails each lease statement; and an old pod neither writes nor reads the cancel mark of #909, so
the fence of ADR-0030 does not hold — a side effect can commit after a cancel. The check at start
(`PostgresSchemaTooNewError`, `MongoSchemaTooNewError`) refuses a *new start* of an old pod; it never
stops one that is already running. SQLite had no version at all, and the same holds for several
processes on one file.

## Decision

- **One rule for every upgrade that changes a store schema** (PostgreSQL, MongoDB, SQLite): **stop
  every instance of the old version → run the migration → start the new version.** There is no rolling
  upgrade across a schema change in 0.1.x. An upgrade that changes no schema may still roll, and a
  `pre-upgrade` / `PreSync` hook stays right for it (`migrate` prints `nothing to apply`).
- **The rule is enforced where a tool can see a violation.** `agboss-postgres migrate` and
  `agboss-mongodb migrate`, when the database's applied version is below the build's, refuse while
  execution leases are live on the server's clock (`PostgresLiveLeasesError`, `postgres.live-leases`, and
  its MongoDB twin: the count and up to five holder ids; `--allow-live-leases` / `allowLiveLeases: true`
  overrides). A start with `SchemaSetup.MigrateOnStart` is held to the same rule: with migrations pending
  it waits (twice the longest lease left, a minute to ten) for live leases to lapse (a stopped single instance's own do) and fails with
  the same error while one is live; `allowLiveLeases: true` in the store's settings (the environment's `postgresAllowLiveLeases: true`, `mongodbAllowLiveLeases: true`) overrides it; when the applied version equals the
  build's, `migrate` stays a no-op and exits 0. A lease check cannot see an **idle** old pod — it holds
  no lease — so the docs name the blind spot, and the sequence stays the operator's.
- **A file or database says what version it is, and an older build refuses it.** SQLite is stamped
  with its schema version (table `agboss_schema`, not `PRAGMA user_version`, which the turn store counts
  its own migrations in on the same file); a build opening a stamp above its own fails at open with
  `SqliteSchemaTooNewError` (`sqlite.schema-too-new`), before any store creates a table. A file with no
  stamp is a 0.1.0 file and is migrated. The released 0.1.0 never reads the stamp: for it, the rule is
  documented, not enforced.
- **A backstop for what the sequence misses.** `channel` of a pause is a column an old writer does not
  fill. It is filled again where a scan can no longer see the gap: SQLite fills it at every open and
  a page filtered by channel reads a pause whose column is empty from its record; PostgreSQL makes it a
  stored generated column in a new migration; MongoDB fills a missing `channel` before a
  channel-filtered scan, as `step` is filled before the newest-by-step read.
- **Additive is not safe by itself.** A change that "an older instance neither writes nor reads" is
  additive for the *schema* but not for the *guarantee*: the guarantee holds only when no old
  instance runs. The docs of such changes (#909) say that.

## Consequences

- An upgrade across a schema change has downtime: the time between the last old instance stopping and
  the first new one serving. A deployment that cannot afford it waits for a release that is
  compatible both ways, which 0.1.x does not promise.
- Helm `pre-upgrade` and Argo CD `PreSync` examples are restricted to upgrades without a schema
  change; across one, the Deployment is scaled to zero first.
- A rolled-back application over a migrated store is refused at start, in all three stores, with a
  typed error; migrations are never rolled back.
- A 0.1.0 process left on a 0.1.1 SQLite file is not stopped by anything but the operator.
