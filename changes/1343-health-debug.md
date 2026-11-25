---
section: Breaking
issue: 1343
---

**`@HealthCheck` options are optional, `check` may be sync and takes a context, and the reasons are plain strings** (#1343): `@HealthCheck()` is valid (the name is the class name in kebab-case, `timeout` defaults to `seconds(5)`), a class needs no `implements HealthCheckHandler`, and `check(ctx?: HealthCheckContext)` may return the result synchronously; `ctx.signal` aborts when the check passes its `timeout`. `HealthCheckResult.unhealthy(reason)` and `.degraded(reason)` take the reason itself — `HealthCheckResultOptions` is removed. `JudgeVerdict.failed(reason, { metrics? })` takes the reason as its first argument (was `failed({ reason, metrics? })`).

**`HealthReport` has `isBusy`, `isAlive` and `isReady`**: a full instance (`@Application({ executionLimits: { maxConcurrentSteps } })` with no free slot) is `isBusy` — and not `isReady` — while `status` stays what its components say; the `step-slots` component and `HealthComponentKind.StepSlots` are removed (a `Degraded` component is no longer hidden by a full queue, and a `Degraded` instance is still ready). Map a readiness probe to `report.isReady` (200, else 503) and a liveness probe to `report.isAlive`.

**`LogLevel.Debug = "debug"`** is added next to `Info`, `Warn` and `Error`.
