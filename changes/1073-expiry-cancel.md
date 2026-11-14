---
section: Fixed
issue: 1073
---

**`app.cancel` during a pause's expiry always wins** (#1073, #941): a cancel of a paused tree now
writes its request where every path reads it (the tree's cancel key, beside the lease store's mark), so
one that arrives while the channel's `onPauseExpired` runs, or after its decision was recorded and
before the run goes on, drops the decision: the run ends cancelled, `app.cancel` returns
`{ cancelled: true }` and nothing of the decided or escalation path runs. No migration.
