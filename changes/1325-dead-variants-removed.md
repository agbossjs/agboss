---
section: Breaking
issue: 1325
---

**Four error variants that nothing threw are removed** (#1325): `ExecutionError.LeaseLost`, `ExecutionError.ApplicationStopping`, `StepError.ToolTimeout` and `GuardrailError.Failed`. Catch the classes the runtime throws: `ExecutionLeaseLostError` (`execution.lease-lost`, `execution.lease-lost.not-started`), `ApplicationStoppingError` (`app.stopping`), `ToolTimeoutError` (`tool.timeout`, which the agent loop hands to the model and which never fails a step), and `StepError.Guardrail` for a guardrail that could not decide. `GuardrailError` is the blocked guardrail only (`GuardrailError.Blocked`). Both lease-lost codes and `app.stopping` stay hand-over codes: no `.onError` takes them.
