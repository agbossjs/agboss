---
section: Added
issue: 941
---

**A pause has a deadline: `expiresIn`, `PauseExpiration`, `PauseExpiredError`** (#941, #910):
`@ChannelRole({ expiresIn: hours(24) })` (at least `seconds(1)`), overridable by a question step
(`.toQuestion(Role, { expiresIn })`, also the side path `toQuestion(Role, { expiresIn })`) and a tool
(`@Tool({ channel, expiresIn })`), fixes the pause's absolute deadline when it is made —
`result.pending[].expiresAt`; a run's deadline bounds every pause too (the smaller wins, a tie goes to
the run). The deadline is hard: an answer at or after it is `PauseClosedError` (`reason: expired`),
decided atomically in the store. Within seconds the pause timers' expiry look takes the tree under its
lease and asks the channel's optional `onPauseExpired(ask)` (`implements PauseExpiryHandler<Role>`):
`PauseExpiration.fail()` fails the step with `PauseExpiredError` (`step.pause-expired`;
`.onError(PauseExpiredError, …)` escalates; an agent's approval or question call fails the whole
agent step, its spend kept) and `PauseExpiration.decide(answer)` goes on with that answer, validated
like a resume's and recorded as answered by the channel (`PauseResolution.DecidedOnExpiry`).
The handler runs once per expiry (again only after a crash before its decision was recorded), so it
must only read; a throw, a timeout, a value that is no expiration or an invalid answer fails the
expiry (`ExpiryHandlerError` as the cause, `pause.expiry-handler-failed` warned, never its message).
A pause the run's deadline bound fails the run with `DeadlineExceededError` and asks nobody; a cancel
always beats an expiry. New: `ResumeReason.Expired` (`onExecutionResume` announces every pass an
expiry starts once, also one that takes no decision), `LeaseTakeoverReason.Expired`, assembly rules
`[channel.expires-in-invalid]`, `[tool.expires-in-without-channel]`, `[question.expires-in-conflict]`,
log codes `pause.expiry-handler-failed`, `pause.expiry-failed`; `agboss describe` prints each
`expiresIn`. Over A2A the task goes `WORKING`, then `FAILED` (`step.pause-expired`) or `COMPLETED`.
Reminders, extensions and the quorum bound follow (#942, #945).
