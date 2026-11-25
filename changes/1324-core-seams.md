---
section: Added
issue: 1324
---

**Core helpers for stores outside the core** (#1324): `@agboss/core/stores` exports `transitionOf`,
`recordTransitionOf`, `statusPageOf` and `replacementPause` (with its input type
`PauseReplacementInput`), so `@agboss/postgres`, `@agboss/mongodb` and `@agboss/redis` use the
core's rules instead of restating them. The SQLite transaction of an `Idempotency.runOnce` stays
`SqliteConnection.requireTransaction()` (a fault set's store gets it through its injected
`SqliteConnection`); the checkpoint savers stay in `@agboss/core/internal`.
