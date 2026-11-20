---
section: Changed
issue: 1356
---

**The built-in pause stores, their notices and the rate limits are mutated at 100 %** (#1356): the new `pauses`,
`pauses-sqlite`, `pause-notices` and `rate-limits` shards of `packages/agboss/stryker.config.mjs` mutate the in-memory and SQLite
pause stores (transitions, closers, mailboxes, scans, reassignment, migrations), the delivery of a pause's notices and the
rate limit stores and policy. Every file of `packages/agboss/src` is now in a shard or named, with a reason, in
`tests/docs/non-sharded-src.ts`. No behaviour changes. No migration.
