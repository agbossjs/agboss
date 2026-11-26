---
section: Breaking
issue: 1310
---

**Expiry API conforms to the spec** (#1310): `PauseExpiration.reassign` and `ReassignExpiration` lose the `channel` field — an expiry is domain policy and names no `@Channel`; the new target's one, or its `@ChannelSelector` (it reads the escalation in `ctx.trail`), carries the pause (`app.reassignPause` keeps `channel?: Class`). An automatic reassignment from `onExpired` does not call the target's `permitReassign`: that hook authorizes an outside `actor`, a worker's timer has none, and `escalatesTo` already bounds the move. `ExpiredContext.maxExpiresAt?: Date` is the latest instant the chain's `maxTotalTimeout` limits let the pause wait until (absent: no limit). `PauseExpiration<TTarget = never>` and `DecideExpiration<out TAnswer>` are covariant (a bare `PauseExpiration` is `fail()` or `reassign(…)`), so a `decide(…)` result is assignable to a target's expiry type. Stale doc comments ("`answeredBy` is the channel's name", the channel's `onPauseExpired`) now say the target's `onExpired` and an answer by the expiry, no person.
