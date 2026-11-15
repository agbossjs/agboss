---
section: Changed
issue: 1188
---

**Scenario 23 is true of a store whose client retries a commit** (#1188, #1017) — MongoDB's
`commitTransaction` is idempotent per transaction, so after one reset after the COMMIT its retry
learns the real outcome and nothing is unknown: the scenario asked for a hand-over that such a store
rightly never makes. A store set may declare `FaultStoreSet.resolvesCommitByRetry: true` (optional,
`false` by default: PostgreSQL and SQLite are unchanged). On it scenario 23 asks that the charge
lands once on the pod that made it, with no hand-over, and the new scenario 23b —
`DatabaseProxy.dropAfterRepeated` cuts the answer of the retry too — is the truly unknown commit: the
holder hands over, the other pod replays the row, one charge; its sabotage (the classifier off) must
fail `no-undo-on-hand-over`. Sets that do not declare it skip 23b. A sabotage that cannot run on a
set is now a skipped case, as a scenario is.
