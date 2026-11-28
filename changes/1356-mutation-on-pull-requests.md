---
section: Changed
issue: 1356
---

**The mutation shards run in GitHub on pull requests, and on demand from any branch** (#1356): a `mutation-plan` job
(`scripts/mutation-changed.mjs`) lists the shards whose mutated files, tests, vitest config or definition the pull
request changes, and the reusable `mutation-shards.yml` runs only those, up to 10 at once. The result is informational:
`check` fails on a red shard only when the repository variable `MUTATION_BLOCKING` is `true`. `mutation-nightly.yml`
takes a `shards` input (`gh workflow run mutation-nightly.yml --ref <branch> -f shards=a,b`, or `all`), and every shard
job writes its survivors and the lines no test runs (file:line) as a job summary, with its JSON report as an artifact.
No behaviour of the framework changes. No migration.
