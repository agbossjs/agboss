---
section: Breaking
issue: 1341
---

**A cancel is an outcome, not an error** (#1341, part a): `app.execute` and `app.resume` of an
execution that `app.cancel`, an `AbortSignal` or a cancel request stops now resolve with
`ExecutionStatus.Cancelled` once what it had undoable is undone, instead of rejecting with
`ExecutionCancelledError` (an undo that fails still rejects with `CompensationFailed`).
`ExecutionOutput` is a union on `status` — `FinishedExecutionOutput`, `PausedExecutionOutput`,
`StoppedExecutionOutput`, `CancelledExecutionOutput` — so `output` and `finish` exist only when
`Finished`. New: `ExecutionStatus.Stopped` / `Cancelled`, `onExecutionCancel` and `onExecutionStop`
on `@Observer` (a root's cancel no longer reaches `onExecutionError`), the `cancelled` execution
record and `stopped` / `cancelled` history, child and durable statuses, and the `cancelled` /
`stopped` outcomes of `agboss.instance.executions.ended`. A cancelled run's record is `cancelled`
(not `failed`); historical cancelled runs are not backfilled. Store follow-up: the stored values
`stopped` and `cancelled` of an execution record, `stopped` of the history and of a child.
