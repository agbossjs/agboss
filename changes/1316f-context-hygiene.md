---
section: Breaking
issue: 1316
---

**Context hygiene** (#1316f): `ExecutionContext` gains `application` (the running instance's `ApplicationContext`, the same as `tenant.application`) and `handledError` (the failure the `.onError` side path the step runs on took in, as the `HandledErrorRecord` of `ExecutionOutput.handledErrors`; the same in the branches of a launch on that path; `undefined` on any other step). A new assembly rule `[context.reserved-field]` refuses a `TenantContext` or `ExecutionContext` subclass whose field shadows one the framework sets (`tenantId`, `ownerId`, `executionId`, `threadId`, `tenant`, `application`, `handledError`, `step`, `workflow`, `signal`, …), so a custom context can no longer spoof the tenant or the owner.
