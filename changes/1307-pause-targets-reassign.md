---
section: Breaking
---

Pauses: a target owns its pauses' lives. `assign` and `resolveTimeout` run when a pause opens; `ChannelOutcome.awaitReply({ externalRef })` keeps the channel's reference; `app.reassignPause({ pauseId, target?, channel?, assignees?, timeout?, reason? })` changes a pause in place (same id, `onPauseReassigned`) or moves it to another target or channel (a new pause, the old channel told `closed`), checked by `permitReassign` first and by `escalationLimits` (`maxReassignments`, `maxExtensions`, `maxTotalTimeout`) atomically; `onExpired` on the target replaces `onPauseExpired` on the channel and `PauseExpiration.reassign` takes `target`, `channel`, `assignees`, `timeout`. `pauseKeyOf`, `PauseAnswer` and `PauseSite` moved from `@agboss/core` to `@agboss/core/stores`; `@Channel({ timeout })` bounds its `send`.
