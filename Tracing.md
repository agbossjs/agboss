# Tracing

Every run can be traced into a **self-hosted Langfuse** — the graph steps, every model call with
its prompt, answer and tokens, every tool call. Nothing leaves the machine. Decision:
[ADR-0005](ADR-0005-Tracing-with-self-hosted-Langfuse).

## Start it

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
- writes `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` into the project `.env`.

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
not LangChain, so they are **not** in Langfuse — their cost is in the turn financials under every
answer ([FinOps](FinOps)).

## Find the trace of an answer

The first line under every answer (CLI and chat) names the conversation and links to it:

```
thread d26cee38-538e-4a3b-b6ea-0a5bdc464f82 · http://localhost:3000/project/agboss/sessions/d26cee38-…
researcher · stop: jev confidence 0.99
```

`threadId` is always in the result; `traceUrl` is there when tracing is on and
`LANGFUSE_PROJECT_ID` is set (`scripts/langfuse.sh` writes it). The link opens the session — every
turn of the conversation.

## Off by default

Without the three `LANGFUSE_*` variables there is no tracing and nothing changes. Spend, Terns and
answers never depend on it. Tracing uses an isolated OpenTelemetry provider — the core does not
register global OpenTelemetry — and is flushed when the app closes.

## Why not LangSmith

LangSmith tracing uploads prompts, inputs and outputs (e.g. a resume in `job-scout`) to a third-party
cloud. Studio itself works without it. Note that the model providers (OpenRouter, Kimi, Jev) still
see what is sent to them — tracing does not change that.
