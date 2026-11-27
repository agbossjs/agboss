---
section: Changed
issue: 1356
---

**A mutation shard's tests must run what the shard mutates, a pull request runs the shards it touches, and a red nightly
opens an issue** (#1356): the nightly mutation run was red from 2026-11-25 and nobody saw it for three nights, because
the include list of a shard (the tests Stryker runs) had not followed the files its `mutate` list gained, and the PR
job ran on no pull request. `scripts/check-mutation-reach.mjs` runs a shard's tests under coverage and fails when a file the
shard mutates is run by no test of it; `npm run test:mutation:changed` runs that check and the incremental
mutation run on the shards a diff touches only; the CI mutation job runs on pull requests for those shards (and the
`check` aggregator waits for it); the nightly opens or updates the issue "Nightly mutation run is red" on its first red
night and closes it on a green one. The shards' include lists now hold the tests that import their files.
QUALITY.md and RELEASE_CHECKLIST.md require a green nightly on the release head. No behaviour of the framework
changes. No migration.
