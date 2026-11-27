---
section: Breaking
issue: 1307
---

**The pause store contract holds `Date`s, and the pure pause transitions are public** (#1307, G3, Q-A, P6b): in `@agboss/core/stores`
every time of a pause is a `Date` in memory — `PauseRecord` (`askedAt`, `firstAskedAt`, `maxExpiresAt`, `resolvedAt`,
`expiresAt`, `remindAt`, `boundAt`, `closedFirst.resolvedAt`), its chain of custody (`PauseTrailRecord` is gone: the chain is
`PauseTrailEntry[]`, its `at` and `expiresAt` dates), `PauseNotice` (`writtenAt`, `closedAt`, `expiresAt`, `previousExpiresAt`),
`PauseMailbox.headWrittenAt`, `PauseSeen.expiresAt`, `PauseTimeoutChange`, `PauseDeadlineSet`, `PauseLimitsOffer.maxExpiresAt`,
`PauseScanAfter.at`, the answer log's `PauseAnswerRecord` and the Turn store's `PauseAnswerEntry.askedAt`. `ExecutionPauseRecord`
is gone: `result.record.pauses` is a list of `PauseAnswerRecord`, `ChildExecutionRecord` and `ExecutionRecord` default to it.
ISO 8601 text is only what a store keeps in a raw column or JSON: write `date.toISOString()` (never a `Date` into a text column:
a driver formats it in local time with an offset and the column stops sorting by instant), read it back with the new
`instantOfText(text, field)` of `@agboss/core/stores` — only exactly what `toISOString()` writes (four-digit year, milliseconds,
`Z`) is read; any other spelling, an offset or a missing zone included, is `StoreError.UnreadableRecord` naming the field and
never the value. `pauseAnswerRecordOfValue`, `pauseRecordOfJson` and `pausedRunOfValue` (the paused run's `pending[].expiresAt`
is read now) already do. Compare two times with `sameInstant` / `isBefore` of `@agboss/core/stores`, never with `===` (a
reference compare). The in-memory store copies the `Date`s it is given and hands out; the events, hook contexts, listings and
`result.pending` copy the record's `Date`s too, so a `setTime` in user code moves nothing stored.

`@agboss/core/stores` now exports the pure transitions every store applies, so a store of your own deletes its copies of the
rules: `PauseTransition`, `decideChange`, `resolveChange`, `cancelChange`, `expireChange`, `closeUntakenChange`, `remindChange`,
`markSentChange`, `reassignChange`, `timeoutChange`, `isWithinCap`, `reassignedPause`, `openingNotices`, `inFirstSendNotices`,
`isOpenAt`, `isDueAt`, `onceNotices` (the rule of `noticeOnceByTenantIdAndPauseId`) and the `PlannedNotice` they write, with
`sameInstant`, `isBefore`, `isAtOrBefore`, `instantOfText`, `assertValidInstant`, `assertPauseInstants` and `assertPauseAnswerInstants` (over a `PauseAnswerRecord` the answer log keeps). An Invalid Date
(`new Date(NaN)`) or a date outside the years 0000-9999 (its ISO text is the six-digit `+010000-...` form the reader refuses) is refused before anything is written, by the core's stores and by the rules, with
`StoreError.UnreadableRecord` naming the field (the answer log too) and saying that an Invalid Date was given and nothing was written (`isInvalidDate`, not a row to repair): it would be `null` in JSON and unreadable after. The mailbox operations (claim, acknowledge, renew, retry, the stale set-aside) and a saved paused run's `pending[].expiresAt` refuse it the same way, and the contract pins every transition and notice. The pause contract of `storeConformance` has new cases that fail a
store that truncates a time, reads text in the wrong zone, hands out the instance it holds, compares two `Date`s by
reference, binds a scan's keyset as another spelling of a time, orders two pauses of one millisecond by anything but
`(tenantId, pauseId)` or writes an Invalid Date. A pause record or mailbox row a store wrote with another spelling of a time is unreadable: write the texts as
`toISOString()` does.
