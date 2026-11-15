---
section: Added
issue: 946
---

**Reassign an open pause to another addressee: `app.reassignPause`** (#946, #910): `await
app.reassignPause({ pauseId, assignee: "deputy-3" }, { answeredBy })` (the `ownerId` for a thread
owner's pause — who may answer may reassign; `PauseCallerOptions`) moves an open pause to another
addressee of the same channel without running the agent or the step again, and returns
`PauseReassignment` (`pauseKey` only — the new pause id is a capability: it goes to the channel's
`send` and to a `@PauseListener({ allowAnswering })`, never to the caller or a log). The channel is
asked again: `ChannelAsk` gets two optional fields, `assignee` and `replaces` (`{ pauseId }` of the old
message), absent on a first send; its optional `onPauseClosed` hears `reason: reassigned` for the old
message — no order is imposed, the channel decides whether to edit the old message from `send` or from
the notice. The old id answers nothing (`PauseClosedError`, `reason: reassigned`, also
`PauseResolution.Reassigned` on the record); the new pause keeps the deadline, the question and the
branches; a reassignment after the deadline is refused (`PauseClosedError`, `reason: expired`); two
reassignments, or a reassignment and an answer, at once: the store lets exactly one win. An instance
that dies between the write and the new send, or a channel that fails there, is made up by the
pause timers of another instance within a minute (`send` is at-least-once). A reassigned approval inside
an agent keeps its sleeping loop, its spend and its place in `result.pending`; the old pause record is
kept while its replacement is stored.

Stores (`@agboss/core/stores`): `PausedExecutionRepository` gets two abstract methods —
`reassignByTenantIdAndPauseId(tenantId, pauseId, replacement: PauseReplacement, at, recipients)` (one
transaction: the old pause `Cancelled / Reassigned` with `reassignedTo`, the replacement `Pending` and
unsent under the step key `<original>~r<n>`, the old pause's `closed` notices; `undefined` when it is not
`Pending` or its deadline is at or before `at`) and `findPendingUnsentReassignedBefore(cutoff, limit, after?)` (ascending by `(askedAt, tenantId, pauseId)`, a keyset)
— and `PauseRecord` the fields `assignee?`, `reassignedTo?`, `reassignedFrom?`; `deleteByResolvedAtBefore`
keeps a reassigned pause while its replacement is stored. The published `pausedExecutionContract` gains
the reassignment cases (13 groups), and the fault suite scenario 28 (`s28-pause-reassign-kill-before-send`,
a pod killed between the reassignment and the new send). `agboss-postgres` and `agboss-mongodb` implement
the two methods when they re-pin (#1064).
