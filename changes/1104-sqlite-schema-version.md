---
section: Changed
issue: 1104
---

**An upgrade that changes a store schema is stop → migrate → deploy; a SQLite file knows its version** (#1104): there is no rolling upgrade across a schema change in 0.1.x
([ADR-0034](https://github.com/agbossjs/agboss/wiki/ADR-0034-Schema-upgrades-stop-the-old-version-first)).
A SQLite file is stamped with its schema version (table `agboss_schema`); a build that finds a stamp
above its own refuses the file at open with `SqliteSchemaTooNewError` (`sqlite.schema-too-new`),
before it writes a row, as the PostgreSQL and MongoDB stores do. A file with no stamp is a 0.1.0 file
and is migrated and stamped. The published 0.1.0 never reads the stamp, so stop its processes before
upgrading. The pause `channel` is filled at every open, and a page filtered by channel finds a pause
that an older process wrote without it. The Wiki pages on upgrading, Running on PostgreSQL, MongoDB and
Kubernetes say stop → migrate → deploy and restrict the `pre-upgrade` / `PreSync` hook examples to
upgrades without a schema change. Migration: before upgrading a SQLite file, stop every process still
on 0.1.0.
