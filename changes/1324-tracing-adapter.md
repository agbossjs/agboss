---
section: Breaking
issue: 1324
---

**Tracing is vendor-neutral OpenTelemetry; Langfuse moved to `@agboss/langfuse`** (#1324f).
`createApp(App, { tracerProvider })` takes an OpenTelemetry `TracerProvider` (yours: `app.close()`
only flushes it) or a `TracingAdapter` (the application's: `app.close()` flushes and shuts it down;
`TracingAdapter` and `TraceLinkContext` are exported). `@agboss/core` no longer depends on
`@langfuse/*` and no longer reads `LANGFUSE_*`: without a `tracerProvider` nothing is traced.
`LangfuseTracer` (`new LangfuseTracer({ publicKey, secretKey, baseUrl, projectId })`, or
`LangfuseTracer.fromEnv()`) is in the new package `@agboss/langfuse`. The framework now emits its
own spans and **masks every value with the workflow's PII policies (a child's: its ancestors' too)
before it is set on a span**, so an external provider never sees an unmasked value — nothing relies
on a processor that rewrites finished spans. `ExecutionOutput.traceUrl` is the adapter's link, on
every status. `AppOptions` is renamed `CreateAppOptions`. The pause metrics are labelled `workflow`,
`target` and `channel` (not `role`); `agboss.instance.pauses.extended` is replaced by
`agboss.instance.pauses.timeout_changed`, and `agboss.instance.pauses.reassigned` is added;
`PauseTally.extended` is `timeoutChanged`, with `reassigned`.
