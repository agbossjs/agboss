---
section: Changed
issue: 1356
---

**The `cancel-x-pauses` and `recovery` mutation shards are back at 100 %** (#1356): how a pause step opens its record and picks a channel (what a `@ChannelSelector` is given and may answer), a channel decision that lost its write, a pause moved to another target's channel, what `onExpired` is told and how an expiry's reassignment is moved, counted or falls back to `fail()`, a stop's end of a tree's pauses, the wake of a parked or an answered root (frozen, business rest, the operator's history), a drained tree's kept record, an unstarted run's hand-over and the lift of an operator's pause are pinned with exact values. **An expiry no longer treats every failure of the target lookup as a removed target:** only `UnknownPauseTargetError` (a deploy removed the target) expires the pause as `fail()`; any other failure of the lookup (a container error) is the look's to retry, so no decision is recorded against the pause for it.
