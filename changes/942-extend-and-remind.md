---
section: Added
issue: 942
---

**Extend a pause; remind before its deadline: `app.extendPause`, `remindBefore`** (#942, #910):
`await app.extendPause({ pauseId, expiresIn: hours(24) }, { answeredBy })` (the `ownerId` for a
thread owner's pause — who may answer may extend) moves an open pause's deadline to `now + expiresIn`
and returns `PauseExtension` (`pauseKey`, `expiresAt`, `previousExpiresAt`). Refused: a closed pause
or one past its deadline (`PauseClosedError`, `reason: expired`), a pause with no deadline (none is
ever added), a deadline not later than the current one, and one past the deadline of the run (or
quorum) the pause was made under — exactly that deadline is allowed (`DtoValidationError`, `dto:
"ExtendPauseRequest"`); another tenant's pause is `UnknownPauseError`. The store applies it
atomically against the expiry look — one wins. `@ChannelRole({ remindBefore: hours(2) })` (a positive
finite duration shorter than the role's `expiresIn`, `[channel.remind-before-invalid]`) fixes a
reminder time `expiresAt − remindBefore` when the pause is made and again by an extension; a step's or
tool's `expiresIn` no longer than it gives that pause none
(`[channel.remind-before-exceeds-expiry]`, a warning). The pause timers' reminder look writes
"expiring" once per deadline whatever the number of instances, taking no lease and moving nothing of
the run. New optional notices, delivered at least once like `onPauseClosed`: a channel's
`onPauseExtended(event)` / `onPauseExpiring(event)` (`ChannelPauseExtendedEvent`,
`ChannelPauseExpiringEvent`) and a `@PauseListener`'s `onPauseExtended` / `onPauseExpiring`
(`PauseListenerExtendedEvent`, `PauseListenerExpiringEvent`); a channel that overrides any notice has
a mailbox. `agboss describe` prints `reminds 2 h before`. Working-time durations follow (#944).

`app.extendPause(request, options?: PauseCallerOptions)` takes the caller fields only —
`ThreadOwnerPauseOptions` (`tenantId?`, `ownerId?`) or `ChannelPauseOptions` (`tenantId?`,
`answeredBy`), none of a run's `CallOptions`; `ResumeOptions` still extends them, so `app.resume`
is unchanged. Stores (`@agboss/core/stores`): the argument of `extendByTenantIdAndPauseId`, `{
expiresAt, remindAt? }`, is named `PauseDeadlineChange` (it was `PauseExtension`, unreleased — no
published version had it); `PauseExtension` now names the app's result of `extendPause`.

`findPendingByRemindAtBefore` takes the optional keyset `after?: PauseScanAfter` like `findPendingByExpiresAtBefore`
(stores entry; the contract suite has a case for it); the reminder look pages with it and starts each reminder
without waiting, so another application's due pauses on a shared store never hide yours. A pause extended to exactly its
run's deadline expires as the run's own (`DeadlineExceededError`, the channel's expiry decision not asked).
