---
section: Changed
issue: 1356
---

**A mutation shard's tests must run what the shard mutates, and a red nightly opens an issue** (#1356): the nightly
mutation run was red from 2026-11-25 and nobody saw it for three nights, because the include list of a shard (the tests
Stryker runs) had not followed the files its `mutate` list gained. `scripts/check-mutation-reach.mjs` runs a shard's
tests under coverage and fails when a file the shard mutates is run by no test of it (first step of a shard's job in the
nightly and in a dispatch of ci.yml); `npm run test:mutation:changed` runs that check and the incremental mutation run
on the shards a diff touches only; the nightly opens or updates the issue "Nightly mutation run is red" on its first red
night and closes it on a green one. The shards' include lists now hold the tests that run their files. QUALITY.md and
RELEASE_CHECKLIST.md require a green nightly on the release head. No behaviour of the framework changes. No migration.
