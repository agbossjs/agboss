---
section: Breaking
issue: 1341
---

**`app.stop` and structured interruption** (#1341, part b): `app.stop(threadId, { reason?, mode?, ownerId?,
tenantId? })` halts a thread's execution where it stands — what it did is kept, nothing is undone (no
`compensateWith`), and its `app.execute` / `app.resume` resolves `ExecutionStatus.Stopped` (with the `reason`,
the spend, no `finish`), its record is `stopped`, its pauses close as `TreeEnded`, `onExecutionStop` is
observed once. It returns `{ state: StopRequestState }` (`Stopped`, `Stopping`, `NotRunning`). `mode` is
`InterruptMode.AfterStep` (the default: the step in flight finishes and commits, no step starts after it) or
`Immediate` (the step in flight is aborted and every new write of the tree is refused with
`ExecutionStopFencedError`). `Cancel > Stop`; a repeated stop writes again, so one that died half way is
completed. **A finish never lands over a durable stop or cancel mark**: a run that reached its finish after
the mark ends `Stopped` / `Cancelled`, never `answered`. A cancel takes `reason` into its output and its
history; the thread's history reads `running`, `stopping`, `stopped`.

`executionContext.onInterrupted(cleanup)` registers a cleanup of the current step or tool call that runs only
if it is interrupted (`InterruptReason`: `Paused`, `Stopped`, `Cancelled`, `TimedOut`, `HandedOver`), awaited,
newest first, before the frame closes and before the lease is released or an undo starts; one that throws is
reported to the new `@Observer` hook `onInterruptCleanupError` and never fails the execution; refused inside
`Idempotency.runOnce`. `TestApp` has `stop` and `getStatusHistory`.

Added: `app.stop`, `StopOptions`, `StopOutput`, `StopRequestState`, `InterruptMode`, `InterruptReason`,
`ExecutionContext.onInterrupted`, `ExecutionObserver.onInterruptCleanupError` / `InterruptCleanupErrorEvent`,
`ExecutionOperation.Stop`, `ExecutionLeaseRepository.requestStop` / `stopOf` (and `StopMark`),
`ExecutionStopFencedError`. Not yet (1341c): `app.pause` / `unpause`, `fencedThroughToken`, `dual_paused`,
`InterruptReason.Paused` delivery, the cleanup bound by `shutdownTimeout`.

Store follow-up (train T3): on the lease row `stop_requested_at` and `stop_mode` (`after-step` /
`immediate`, escalating, never lowered, never cleared) written by `requestStop(tree, mode, transition?)` in
one transaction with the status-history row (only when the call set or escalated the mark), read by `stopOf`;
the fenced-effect and outbound-call checks refuse a non-compensation or compensation write with
`ExecutionStopFencedError` when `stop_mode = 'immediate'` and no cancel mark is set (else the cancel's rules);
a Redis lease store re-pushes the stop's state on every `requestStop` (also when the database row was already
set) and delegates the durable write to the `EXECUTION_ID_STORE` store. New contract cases:
`execution-lease-stop.cases.ts`, `fenced-effect-stop.cases.ts`.
