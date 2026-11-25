---
section: Added
issue: 1310
---

**An expiry may hand a pause on** (#1310, part a): `onPauseExpired` may return
`PauseExpiration.reassign({ assignees, timeout?, reason? })` beside `fail()` and `decide(answer)`. The
store's due-at compare-and-set (a reassignment that carries `due` applies only to a pause whose deadline
is at or before the write) closes the old pause `reassigned` and makes a new one for the assignees: a new id,
the old chain of custody plus a `reassigned` entry (the reason masked by the pause's workflow's PII
policy), a new deadline (`timeout` after now, else the channel's `expiresIn`, never past the run's or a
quorum's bound) and no reminder; the re-send look asks its channel and the tree rests paused. A request that
is not valid (no or repeated assignees, a timeout under a second, a blank reason) or a deadline already past
expires the pause as `fail()` (`ExpiryProblem.AnswerInvalid` is kept). A pause whose deadline is the run's or
a quorum's is never reassigned.

Store follow-up (T4): `PauseReplacement.due { expiresAt?, expiryBound? }` for `reassignByTenantIdAndPauseId`
in `@agboss/postgres` and `@agboss/mongodb` (the guard is "due at the write" instead of "open at the write";
the replacement takes the new deadline and drops `remindAt`); contract case in
`paused-execution-reassign-trail.cases.ts`.
Not here: a `WorkingDuration` timeout (needs the pause's calendar), `target` (needs the F2 target/channel
split) and `escalationLimits.maxReassignments`.
