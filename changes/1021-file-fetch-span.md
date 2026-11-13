---
section: Added
issue: 1021
---

**A file fetch by url is one OpenTelemetry `CLIENT` span** (#1021, after #916): the fetch builds
its own `ClientRequest` over a socket it checked first, so it does not go through `https.request`
and `instrumentation-http` or dd-trace never saw it. Routing it through `https.request` would
reopen the SSRF (an agent's `addRequest` runs before the peer is checked: a second, unguarded
lookup, a proxy `CONNECT` with credentials, trace headers to an untrusted origin), so the span is
emitted explicitly with `@opentelemetry/api` (`trace.getTracer("@agboss/core")`): kind `CLIENT`,
`http.request.method`, `http.response.status_code`, `server.address`, `server.port`, `url.full`
without the query string and the fragment (a pre-signed S3/GCS token never reaches a trace) and an
error status with `error.type` when the fetch fails or is refused. No propagation header
(`traceparent`, `baggage`) is injected into the file request. Without an OpenTelemetry SDK the
API is a no-op: no overhead, no error. The span goes to the host's global provider only: the
framework's Langfuse tracing uses an isolated provider and does not receive it. dd-trace's http
plugin is not involved; the span reaches Datadog only when its OpenTelemetry `TracerProvider`
bridge is registered.
