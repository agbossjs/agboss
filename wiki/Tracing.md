# Tracing

Every run can be traced as OpenTelemetry spans — the graph steps, every model call with its prompt,
answer and tokens, every tool call — into the provider you give `createApp({ tracerProvider })`.
The Langfuse end is the package `@agboss/langfuse` (`LangfuseTracer`), a **self-hosted Langfuse**
keeps everything on your machine. Decision: [ADR-0005](ADR-0005-Tracing-with-self-hosted-Langfuse).

## Start a local Langfuse

```bash
scripts/langfuse.sh up       # Docker; first run downloads images (~2 GB)
scripts/langfuse.sh status
scripts/langfuse.sh down     # data stays in Docker volumes
```

`up` keeps Langfuse private and reproducible:

- downloads the official `docker-compose.yml` into `~/langfuse` (`LANGFUSE_DIR` to change);
- binds the UI (3000) and MinIO (9090) to `127.0.0.1` — upstream exposes them to the network;
- generates every secret (upstream defaults are `CHANGEME`) into `~/langfuse/.env` (mode 600);
- turns **telemetry off** (upstream sends anonymous usage stats by default);
- creates the organisation, a project named after the repo, API keys and a user;
- writes `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` into the project `.env` (`LangfuseTracer.fromEnv()` reads them).

Open <http://localhost:3000>; login and password are in `~/langfuse/.env`
(`LANGFUSE_INIT_USER_EMAIL`, `LANGFUSE_INIT_USER_PASSWORD`).

## What gets traced

| Where                                                   | Trace                                                        | Session                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| `agboss run`, `agboss chat`, `app.execute` / `app.resume`       | one trace per turn, named after the workflow, tagged with it | the conversation thread |
| LangGraph Studio (`agboss studio`)                      | one trace per Studio run                                     | `studio`                |

Inside a trace: one span per flow node, named `<kind>.<name>` — `workflow-start.chat` (input guards),
`router.main`, `agent.scout` (its loop: model requests, tool calls, the approval),
`workflow-finish.chat` (the answer and output guards). Jev decisions (routing, guards, quality scores, job ratings) use Jev's own HTTP client,
not LangChain, so they are **not** in the trace — their cost is in the turn financials under every
answer ([FinOps](FinOps)).

## Find the trace of an answer

The first line under every answer (CLI and chat) names the conversation and links to it:

```
thread d26cee38-538e-4a3b-b6ea-0a5bdc464f82 · http://localhost:3000/project/agboss/sessions/d26cee38-…
researcher · stop: jev confidence 0.99
```

`threadId` is always in the result; `traceUrl` is there when the adapter builds a link (`LangfuseTracer`
with a `projectId`, `LANGFUSE_PROJECT_ID` for `fromEnv`; `scripts/langfuse.sh` writes it). The link opens the session — every
turn of the conversation.

## Turn it on: `tracerProvider`

The core knows no tracing vendor and reads no environment variable for it. It emits vendor-neutral
OpenTelemetry spans on the provider you give `createApp` (#1324f):

```ts
// your own OpenTelemetry provider (Datadog, Tempo, Honeycomb, ...): you own it, app.close() only flushes it
await createApp(SupportApplication, { tracerProvider: myTracerProvider });

// a TracingAdapter: the application owns it, app.close() flushes it and shuts it down
import { LangfuseTracer } from "@agboss/langfuse";
await createApp(SupportApplication, {
  tracerProvider: new LangfuseTracer({ publicKey, secretKey, baseUrl, projectId }),
});
```

`TracingAdapter` is `{ tracerProvider, traceUrl?(ctx: TraceLinkContext), forceFlush?(), shutdown?() }`;
`ctx` has the workflow, the thread, the run and the tenant. `ExecutionOutput.traceUrl` is the adapter's
link, on every status (finished, paused, stopped, cancelled); a plain `TracerProvider` has none.
`LangfuseTracer.fromEnv()` (in `@agboss/langfuse`) reads the `LANGFUSE_*` variables for you, if you
keep them.

Without a `tracerProvider` there is no tracing and nothing changes. Spend, Turns and answers never
depend on it. The framework does not register global OpenTelemetry.

### PII never reaches the provider

The framework's own emitter masks **before** it sets: every input, output, metadata value, session id,
tag and error text goes through the PII policies of the workflow it belongs to — a child workflow's
spans by the policies of every workflow of its chain, its ancestors' included (#1150) — and only
then through `setAttribute`, `addEvent` or `setStatus`. A processor or an exporter of your provider
sees no unmasked value, at a span's start or at its end; nothing relies on a processor that rewrites
finished spans. A span whose workflow is unknown is masked by all the application's policies. A mask
that throws leaves `<masked: the PII mask failed>` in place of the value.

Span names are the code's (`router.main`, `agent.scout`); the operation is `agboss.operation`
(`chain`, `llm`, `tool`, `retriever`), the workflow `agboss.workflow.name` and its chain
`agboss.workflow.chain`. The first span of a run carries `session.id` (the thread), `agboss.tenant.id`
and `agboss.run.id`; a model call carries `gen_ai.request.model` and the token counts
(`gen_ai.usage.*`).

## Why not LangSmith

LangSmith tracing uploads prompts, inputs and outputs (e.g. a resume in `job-scout`) to a third-party
cloud. Studio itself works without it. Note that the model providers (OpenRouter, Kimi, Jev) still
see what is sent to them — tracing does not change that.
