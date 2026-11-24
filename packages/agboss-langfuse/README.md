# @agboss/langfuse

Langfuse tracing for [AGBoss](https://agboss.dev): `LangfuseTracer`, a `TracingAdapter` for
`createApp({ tracerProvider })`.

The core does not know Langfuse. It emits vendor-neutral OpenTelemetry spans on the `tracerProvider`
you give it, and applies the `@PiiPolicy` policies of the workflow (and of every ancestor workflow
of a child) to each value **before** it is set on a span — a provider, a processor or an exporter
never sees an unmasked value. This package is the Langfuse end of that: a tracer provider with the
Langfuse span processor, and the link to each execution.

```bash
npm install @agboss/langfuse
```

```ts
import { createApp } from "@agboss/core";
import { LangfuseTracer } from "@agboss/langfuse";

const app = await createApp(SupportApplication, {
  tracerProvider: new LangfuseTracer({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    baseUrl: "https://langfuse.example.com", // your self-hosted server, or https://cloud.langfuse.com
    projectId: "my-project", // optional: ExecutionOutput.traceUrl links the conversation
  }),
});

const result = await app.execute(SupportStart, { text: "hello" });
result.traceUrl; // https://langfuse.example.com/project/my-project/sessions/<threadId>
await app.close(); // flushes the tracer and shuts it down: the application owns it
```

`LangfuseTracer.fromEnv()` reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`
(and `LANGFUSE_PROJECT_ID`) and returns `undefined` when they are not all set. The core itself reads
none of them.

Spans carry `input.value` and `output.value` (masked), `session.id` (the thread), `gen_ai.*` for model
calls and `agboss.*` for the workflow, its chain and the run. The provider is isolated: the process's
global OpenTelemetry is not touched.

`@agboss/langfuse` has the same version as `@agboss/core` and takes it as a peer dependency.
