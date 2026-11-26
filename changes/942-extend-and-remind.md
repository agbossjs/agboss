---
section: Added
issue: 942
---

**Change a pause's deadline (named `app.extendPause` in #942, renamed and widened by #1307); remind before it: `app.setPauseTimeout`, `remindBefore`** (#942, #910):
`await app.setPauseTimeout({ pauseId, timeout: hours(24) }, { actor })` (the `ownerId` for a
thread owner's pause — who may answer may change it) moves an open pause's deadline to `now + timeout`
(#1307: later or earlier, `Timeout.None` takes it away) and returns `PauseTimeoutChangeResult`
(`expiresAt?`, `previousExpiresAt?`). Refused: a closed pause or one past its deadline
(`PauseError.Closed`, `reason: expired`), a deadline past the one of the run (or quorum) the pause was
made under — exactly that deadline is allowed (`PauseError.EscalationLimitExceeded`); another tenant's
pause is `PauseError.UnknownPause`. The store applies it
atomically against the expiry look — one wins. A target's `remindBefore: hours(2)` (a positive
finite duration shorter than the target's `timeout`, `[channel.remind-before-invalid]`) fixes a
reminder time `expiresAt − remindBefore` when the pause is made and again by a timeout change. The pause timers' reminder look writes
"expiring" once per deadline whatever the number of instances, taking no lease and moving nothing of
the run. New optional notices, delivered at least once like `onPauseClosed`: a channel's
`onPauseTimeoutChanged(event)` / `onPauseExpiring(event)` (`ChannelPauseTimeoutChangedEvent`,
`ChannelPauseExpiringEvent`) and a `@PauseListener`'s `onPauseTimeoutChanged` / `onPauseExpiring`; a channel that overrides any notice has
a mailbox. `agboss describe` prints `reminds 2 h before`. Working-time durations follow (#944).

`app.setPauseTimeout(request, options?: PauseCallerOptions)` takes the caller fields only —
`ThreadOwnerPauseOptions` (`tenantId?`, `ownerId?`) or `ChannelPauseOptions` (`tenantId?`,
`answeredBy`), none of a run's `CallOptions`; `ResumeOptions` still extends them, so `app.resume`
is unchanged. Stores (`@agboss/core/stores`): the argument of `changeTimeoutByTenantIdAndPauseId`, `{
expiresAt, remindAt? }`, is named `PauseDeadlineChange` (it was `PauseTimeoutChangeResult`, unreleased — no
published version had it); `PauseTimeoutChangeResult` now names the app's result of `setPauseTimeout`.

`findPendingByRemindAtBefore` takes the optional keyset `after?: PauseScanAfter` like `findPendingByExpiresAtBefore`
(stores entry; the contract suite has a case for it); the reminder look pages with it and starts each reminder
without waiting, so another application's due pauses on a shared store never hide yours. A pause whose timeout was changed to exactly its
run's deadline expires as the run's own (`DeadlineExceededError`, the channel's expiry decision not asked).
