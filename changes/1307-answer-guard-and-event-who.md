---
section: Breaking
issue: 1307
---

**A target that guards its answers is not bypassed by a shorter deadline or a reassignment; `onPauseTimeoutChanged` names who and why** (#1307). A `@ToolApproval` / `@ExternalTask` that declares `permitAnswer` but no `permitTimeoutChange` refuses `app.setPauseTimeout` with `PauseError.PermissionDenied` unless the new deadline is a longer one (an earlier deadline, a deadline where there was none and `Timeout.None` are refused): a shorter deadline makes `onExpired` decide, perhaps `PauseExpiration.decide({ approved: true })`, with `permitAnswer` never asked. Likewise `app.reassignPause` is refused on a target with `permitAnswer` and no `permitReassign`. Declare the hook to allow it (the hook then decides); targets without `permitAnswer` are unchanged. `ChannelPauseTimeoutChangedEvent` and `ChannelListenerTimeoutChangedEvent` carry `actor?` and `reason?` (the PII-masked text the chain of custody keeps), as the reassignment events do.
