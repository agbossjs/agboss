---
section: Changed
issue: 1356
---

**The mutation job runs on pull requests for the shards the change touches** (#1356): a `mutation-plan` job
(`scripts/mutation-changed.mjs`) lists the shards whose mutated files, tests, vitest config or definition the pull
request changes, the `mutation` job runs only those (every shard on a manual dispatch, none on a push), and the `check`
aggregator waits for both (a skipped mutation job passes, a failed one does not). No behaviour of the framework changes.
No migration.
