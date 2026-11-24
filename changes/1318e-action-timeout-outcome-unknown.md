---
section: Breaking
issue: 1318
---

**A timed-out `@Action` is outcome-unknown, signalled, fenced, and never blindly retried** (#1318, part 1318e). `execute` may still finish after its `timeout`, so:
`executionContext.signal` of the action aborts at the timeout (also on a cancel and a lost lease) and `execute` must honour it; an action that went through
`Idempotency` (`runOnce`, `sendOnce`) fails with `StepError.ActionTimeout` and may be retried (the key recognises the repeat); any other fails with the new
`StepError.ActionOutcomeUnknown` (`step.action.outcome-unknown`, `action`, `timeout`) which nothing retries or undoes, for the flow's `.onError` or an operator.
The step's frame is closed at the timeout, so a late write of the orphaned `execute` through the framework (`Idempotency`, the fence) is refused, and the lease fence
is checked again before the action's result is committed. An action still has no default timeout.
