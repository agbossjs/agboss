---
section: Fixed
issue: 1307
---

**Pause compare-and-set hardening** (#1307, store authors): `PauseInPlaceReassignment.seen` and
`PauseReplacement.seen` are now required, and a reassignment without one applies to nothing (the core
always sets it; `isAsSeen` takes a `PauseSeen`). `decideByTenantIdAndPauseId` (a channel's decision at
once) takes the pause only while its deadline is after `at`, like an answer: the core's `decideChange`
is the shared transition, and the in-memory and SQLite stores use it; before, a decision landed on a
`Pending` pause at or after its deadline. An in-place reassignment made while the pause's first send ran
(an expiry's) now reaches the channel: `markSent…` writes a `reassigned` notice to the channel and the
listeners after `opened`. Contract cases: the decision's deadline, a reassignment racing a decision, a
reassignment without `seen`, the notice after a first send. Store follow-up: postgres and mongodb
require `seen`, decide with the deadline and write the notice after the first send.

Review of #1421: `decideByTenantIdAndPauseId` takes a required `seen` (the record the step sent) and
`resolveByTenantIdAndPauseId` an optional one (`app.resume` always sets the pause its `permitAnswer` was
asked over): a decision or an answer over a pause changed in place since (an expiry's reassignment during
the first send, an operator's reassignment during the permit) is refused; a resume then fails with
`PauseError.UpdateContended` (retry asks the permit again). A decision refused on a still-pending,
unmarked pause marks it sent. `isSeenAs` is exported from `@agboss/core/stores`; `isAsSeen(pause, undefined)`
is `false`, no longer a `TypeError`.
