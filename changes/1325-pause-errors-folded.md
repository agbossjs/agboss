---
section: Breaking
issue: 1325
---

**Seven pause errors are variants of `PauseError`** (#1325b): `UnknownPauseError`, `PauseClosedError`, `PauseExtensionContendedError`, `ReplyInterpreterMissingError`, `ExpiryHandlerError`, `WorkingCalendarError` and `UninterpretableReplyError` are removed, with their `…Options` types, from `@agboss/core`. They are `PauseError.UnknownPause`, `PauseError.Closed` (`pauseId`, `tenantId`, `reason`, `closedAt`; the pause id and the tenant stay out of its `details`), `PauseError.UpdateContended` (`pauseKey`, `attempts`), `PauseError.ChannelInterpreterMissing` (`channel`), `PauseError.ExpiryHandlerFailed` (`channel`, `problem`), `PauseError.WorkingCalendar` (`calendar`, `problem`) and `PauseError.UninterpretableReply` (`reason`) — the same `pause.*` codes and sentences; `.onError(PauseError.Closed, …)`, `error.kind` and `instanceof` take the place of the old classes.
