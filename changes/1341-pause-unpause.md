---
section: Breaking
issue: 1341
---

**`app.pause` and `app.unpause`** (#1341, part c, the commands): `app.pause(threadId, { reason, mode,
ownerId, tenantId })` freezes an execution where it stands — `InterruptMode.AfterStep` (the step in
flight finishes and commits, none starts) or `Immediate` (aborted, the tree's token fenced) — and its
`execute` / `resume` resolves `ExecutionStatus.Paused` with `isExternallyPaused: true`
(`PausedExecutionOutput.isExternallyPaused`, `reason`; `ExecutionPauseEvent.isExternallyPaused`,
`reason`). The thread's record goes `paused`, its checkpoint is kept, nothing is undone; the status
history reads `running`, `pausing`, `externally-paused` (`dual-paused` for a tree resting at a business
pause), each row in the transaction of its change. `app.unpause(threadId, { reason, … })` continues it
from the checkpoint (`ResumeReason.Unpaused`, `ExecutionResumeEvent.unpauseReason`) or, at a business
pause, lifts only the operator's freeze and takes what was decided or expired meanwhile; it waits for a
pause that is still parking (the lease is the one place the freeze is lifted). Both return/throw:
`PauseRequestState` (`Paused` | `Pausing` | `NotRunning`), `PauseError.NotPaused`,
`ExecutionError.AlreadyTerminal`, `ExecutionError.ExternallyPaused`. `Cancel > Stop > Pause`: a stop or
cancel ends a parked tree under a lease taken at a token above the pause's fence (the fence is never
lowered); a pause of a tree being cancelled or stopped is refused. `ExecutionOperation.Pause` /
`Unpause`, `TestApp.pause` / `unpause`, `InterruptReason.Paused` told to `onInterrupted` cleanups,
which are now bounded all together by `executionLimits.shutdownTimeout` (a cleanup past it is reported
by `onInterruptCleanupError` and the step goes on).

**Removed:** the legacy `ExecutionFencedError` class. `ExecutionError.Fenced` is the hand-over and the
rejection; a store builds it with `fencedRefusalOf({ scopeKey, token, observedToken })` (the key read
into its tenant and execution). It is no `ExecutionLeaseLostError`.

Store follow-up (train T3, postgres and mongodb): the stores build `fencedRefusalOf(...)` instead of
`ExecutionFencedError.of(...)`; the contract cases and fault scenarios of the core already do.
Nothing else is new for the stores in this part: `requestPause` / `unpause` / `pauseOf` are as in the
`1341c` store layer fragment, and the status history reads the `pausing`, `externally-paused` and
`dual-paused` values.
