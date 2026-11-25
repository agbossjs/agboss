---
section: Fixed
issue: 1325
---

**Error families, review fixes** (#1325, PR #1413): an action that throws an error of any family but a limit, a cancel, a pause, a hand-over, a failed automatic undo or a step's own fails its step as `StepError.Action` with the original as `cause` — so `.onError(StepError, …)`, `skip()` and `joinQuorum` take a failed `A2AError`, `StoreError`, `ConfigError` or `ValidationError` again, and `.onError(A2AError.TaskFailed, …)` still takes it through the cause. A cancel record (`execution.cancelled`, `execution.cancelled.fenced`) is taken by no `.onError`, not even `.onError(AGBossError)`. `StoreError.UnreadableRecord` keeps `ids` out of `details` and names a pause by its key, never its id. Remote and model text stay out of `details`: `A2AError.Contract.differences`, `A2AError.OriginRefused.allowedOrigins`, `StepError.RouterDecision.reason` and `StepError.Guardrail.reason`; a remote task id is checked before it is kept. `A2AError.Deadline` writes `deadlineAt` as ISO text again. The record of the standalone `ApplicationStoppingError` is a hand-over record. An error fact named `kind`, `code`, `name` or `spend` is refused.
