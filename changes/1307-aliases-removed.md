---
section: Breaking
issue: 1307
---

**0.1.0's pause aliases are removed** (#1307, part d): `@ChannelRole({ answeredBy })` (use `answerer`; a role
without one fails `[channel.role-form]`), `WaitingPause.answeredBy` / `PendingPauseBase.answeredBy`, the
`answeredBy` alias of `PauseRecord` (a record that names no `answerer` is refused, never read as
`answeredBy`), `PauseAnswerRecord.responder` (use `answeredBy`, the person), the `answeredBy` field of the
described channel, and the legacy read of a remote child's failure (`RemoteChildFailure`): a queue row whose
`failure` is no durable record is refused with `StoredNamesUnreadableError`. A stored run whose pending pause
carries `answeredBy`, and a stored answer entry or history record that carries `responder`, are refused too
(`StoredNamesUnreadableError`, the field named, no value). No store follow-up: no store wrote these fields.
