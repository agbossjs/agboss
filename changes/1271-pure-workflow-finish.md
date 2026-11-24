---
section: Breaking
issue: 1271
---

**`@WorkflowFinish` is a pure boundary port** (#1271): `@WorkflowFinish({ name, description, output })` is always an empty class that passes the latest value of its `output` type on the path through; `output` is one DTO or a list (`listOf(ItemDto)`, `listOf(oneOf(A, B))`) straight after a `.join()`. `input`, `deps` and the `finish(input)` handler are removed with `FinishHandler`, `HandledFinishOptions`, `PassThroughFinishOptions` and `FinishMethod`; a `finish()` method on a finish class is a compile error. Migration: move the body of `finish(input)` into an `@Action` placed before the finish (`.toAction(TripBookedAction).toFinish(TripBookedWorkflowFinish)`); the finish still commits the open compensations when it is visited. A workflow whose finishes give different shapes may not mix a list with another shape.
