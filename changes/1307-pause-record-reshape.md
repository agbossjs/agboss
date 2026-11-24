---
section: Breaking
issue: 1307
---

**A pause says what it asks, who it is for and who did what** (#1307, part d). The record, the channel's
ask, the events and the options are reshaped; the old forms are removed, not aliased.

- `PauseRecord`, `PendingPause`, `ListedPause`: `ask` becomes `input` (an object: an approval's tool
  arguments, an external task's input, PII-masked) plus `toolCall` (`{ callId, tool, summary? }`, an approval
  only). New: `assignees?` (a 1-of-N pool), `externalRef?`, `trail` (the chain of custody, never empty: `opened`,
  then one entry per reassignment with who, when, to whom and why). `assignee` is gone. `PauseAsk`,
  `QuestionAsk` and `questionAskOf` are gone (`pauseInputOf`).
- `ChannelAsk<T>`: `value` becomes `input` (an approval's arguments, the task's input) plus `toolCall`,
  `expiresAt`, `assignees`, `trail`; `assignee` is gone. `onPauseExpired` is given the same ask. Channel events
  carry `input` and `toolCall` instead of `value`; listener events carry masked `input`, `toolCall`,
  `assignees`, `externalRef` and `trail` instead of `ask`.
- Who acts: `answeredBy: string` becomes `actor: PauseActor` (`{ id, orgId? }`) in `ResumeOptions`,
  `PauseCallerOptions`, `PauseAnswer`, `PauseAnswerRecord`, `ListedPause`, `ExecutionResumeEvent` and the close
  events of channels and listeners. `PauseAnswer.byChannel` becomes `byDelegate`. A bad `actor.id` or
  `actor.orgId` is `dto.invalid` naming the field.
- `app.reassignPause({ pauseId, assignees, reason? })`: `assignee: string` becomes `assignees` (one to 100
  key's texts, none twice); the reason (500 characters at most) is masked by the pause's own workflow's PII
  policy before it is kept. The target's `permitReassign` is called before anything is written (deny on
  false, throw or an unresolvable target: `PauseError.PermissionDenied`); `[pause.permit-hook-not-enforced]`
  no longer names it. The replacement's `trail` is the old pause's plus a `reassigned` entry; the old
  pause's `externalRef` is not the replacement's.
- Messages of a refused answer or reassignment name the pause by its key, never its id.
- Stored: a pause row, a paused run's pending pause, an answer-log entry and an A2A task's pending pause are
  written in the new shape; the 0.1.0 names (`ask`, `assignee`, `answeredBy`, `byChannel`, `asked`) are
  refused with `StoredNamesUnreadableError`, never read.

Store follow-up (T4): `@agboss/postgres` and `@agboss/mongodb` keep the pause as JSON through the core's
reader (`pauseRecordOfJson`) and need no new column; `PauseReplacement` takes `assignees`, `actor`, `reason`
(the contract case `paused-execution-reassign.cases.ts`: trail, pool, dropped `externalRef`), and the answer
log's entry takes `actor`, `input`, `toolCall`, `assignees`, `externalRef`, `trail` (`pause-answer-log.cases.ts`).
