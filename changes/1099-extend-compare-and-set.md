---
section: Fixed
issue: 1099
---

**Two concurrent `app.setPauseTimeout` calls can no longer shorten a pause's deadline** (#1099): the
store's compare-and-set now applies an extension only over the deadline the caller read
(`PauseTimeoutChange.previousExpiresAt`, new and required — the argument of
`changeTimeoutByTenantIdAndPauseId` was added in #942 and is unreleased) and only to a later one, in the one
atomic statement; a caller that lost re-reads and is refused (`DtoValidationError`, "not later") or
extends over the new deadline, and `PauseTimeoutChangeResult.previousExpiresAt` and the `extended` notice are
the deadline the winning write replaced. The store contract has cases for it (two extends at once, an
extension racing the expiry and an answer, the deadline's source reset to `pause`). New warning
`[channel.remind-before-below-tick]` (an error under `--strict`): a role's `remindBefore` shorter
than the pause timers' 5 s tick, whose reminder a tick can skip. A custom store's
`changeTimeoutByTenantIdAndPauseId` must compare `previousExpiresAt` and refuse a not-later deadline.
