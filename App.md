# App — `createApp`

A workflow, built and started: its container (every component, DI), its graph (every assembly rule —
**all** violations at once, before any model call) and the components' `onStart` hooks. The CLI
(`agboss chat`, `agboss run`) and the tests ([Testing](Testing)) use the same `app`.

<!--
```ts file=job-scout.workflow.ts
import { Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Agent({ name: "shortlist-agent", description: "Keeps the shortlist", prompt: "Keep the shortlist.", model: "moonshotai/kimi-k2.6" })
export class ShortlistAgent {}
@Workflow({
  name: "job-scout-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ShortlistAgent)
      .toFinish(ChatWorkflowFinish),
  ],
})
export class JobScout {}
```
-->

<!-- snippet-context
import { ChatWorkflowStart, JobScout } from "./job-scout.workflow.js";
-->

```ts
import { ExecutionStatus, createApp } from "agboss";

const app = await createApp(JobScout); // optional: { env: "staging", profile: "scout-low-thinking" }

const first = await app.execute(ChatWorkflowStart, { text: "save the first job" });
if (first.status === ExecutionStatus.Paused) {
  await app.resume(first.thread, { approved: true, by: "dana" });
}
const next = await app.execute(
  ChatWorkflowStart,
  { text: "and the second" },
  { thread: first.thread },
);
console.log(next.output?.text, next.spend.totalUsd);

await app.close(); // onStop hooks, MCP servers, tracing
```

## `app.execute(Start, input, options?)`

- `Start` must be a `@WorkflowStart` of this workflow (else `NotAWorkflowStartError`); `input` is
  typed by the generated `.agboss/types.d.ts` (`agboss check`) and checked against the start's
  `input` before any call (`DtoValidationError`, the field named, never the value).
- Options: `thread` continues a conversation (without it a new thread is created; its id is in the
  result), `owner` (a thread created with an owner rejects another one — `ThreadOwnerError`),
  `signal`, `metadata` (strings, kept by the run's resumes), `onStream` (token and tool-call events),
  `configurable` (extra LangGraph keys). See [Context and Authorization](Context-And-Authorization).

## The result — `ExecutionOutput`

| Field                                                                 | What it holds                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `thread`                                                              | the conversation id — pass it to the next `execute` or to `resume`                 |
| `status`                                                              | `ExecutionStatus.Finished` or `ExecutionStatus.Paused`                             |
| `finish`                                                              | the `@WorkflowFinish` the run reached, as `{ name }` (absent when paused)          |
| `output`                                                              | the finish's DTO — the business result only (`WorkflowFinishTextDto`: `{ text }`), typed by the finishes of the start's paths |
| `record`                                                              | with `execute(…, { record: true })`: the execution record (path scope, last error) |
| `pause`                                                               | what the run waits for — the tool call waiting for approval (`agent`, `tool`, `args`) |
| `path`                                                                | the flow nodes it visited, in order, by name                                       |
| `spend`                                                               | the `CostReport` of this run ([FinOps](FinOps))                                    |
| `runId`, `compacted`, `traceUrl`                                      | the run's id, what memory compacted, the trace                                     |

A run that fails (a limit, a router, an agent) and that no `.onError` takes throws an `AGBossError`
with a stable `code`; the Tern and the spend are recorded first.

## `app.resume(thread, decision)`

Continues the paused run of the thread with a `ToolCallApprovalDecisionDto` (`approved`, `by`,
`reason?` — [Pause seam](Pause-seam)); same result shape. A thread without a paused run →
`NotPausedError`. A run paused under another workflow version or config is checked by the
workflow's `onIncompatibleResume` policy (`IncompatibleResumeError`).

## `app.cancel(thread)`

Aborts a running run — it stops before its next model or tool call and `execute` rejects with
`WorkflowCancelledError` — or drops a paused one, whose `resume` then throws `NotPausedError`;
`{ cancelled }` is `false` when the thread had neither ([Cancellation and idempotency](Saga-And-Cancellation)).

## `app.close()`

From the call on, no new execution is accepted: `execute` / `resume` reject with
`ApplicationStoppingError` (`app.stopping`) — nothing was cancelled, the request is refused before
an execution starts, so observers get `onRunRejected` (`operation`, `code`, a message without input
values); `cancel` still works. Runs `onStop` of the components, waits for the
running executions to finish or pause, runs `onDestroy`, then closes MCP connections and tracing, and
the stores the app opened. Every hook runs; failures are collected into one `AggregateError`.
Calling it twice is fine.

## Lifecycle hooks

Four hooks, per application instance, for every component the container creates (services,
repositories, providers, tools, handlers, guardrails, observers) — `implements OnInit, OnStart,
OnStop, OnDestroy`, each optional (#261):

| Hook        | When                                                                                    | For                                               |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `onInit`    | the component is created, its dependencies injected and past their own `onInit`         | opening its own: a connection, a pool, a warm-up  |
| `onStart`   | every component is past `onInit`; the app is ready; no `execute` yet                    | what needs the whole app: a check, a log line     |
| `onStop`    | `app.close()`: no new executions are accepted, running ones go on                       | stop taking work, finish its own operations       |
| `onDestroy` | the running executions on this instance have finished or paused; dependants first       | closing connections, releasing resources          |

<!-- snippet-context
import { Injectable, type OnDestroy, type OnInit, type OnStart, type OnStop } from "agboss";
interface Pool {
  ping(): Promise<void>;
  drain(): Promise<void>;
  end(): Promise<void>;
}
@Injectable()
export class PoolProvider {
  readonly pool: Pool = {
    ping: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
}
// @snippet
-->

```ts
@Injectable({ deps: [PoolProvider] })
export class JobIndexService implements OnInit, OnStart, OnStop, OnDestroy {
  constructor(private readonly poolProvider: PoolProvider) {}

  async onInit(): Promise<void> {
    await this.poolProvider.pool.ping(); // no database → the app does not start
  }

  onStart(): void {
    /* the whole app is ready */
  }

  async onStop(): Promise<void> {
    await this.poolProvider.pool.drain();
  }

  async onDestroy(): Promise<void> {
    await this.poolProvider.pool.end();
  }
}
```

- A failing `onInit` / `onStart` → the app does not start: `[di.hook-failed] JobIndexService.onInit
  failed: …` (the original as `cause`); the components already past `onInit` get `onDestroy`.
- A failing `onStop` / `onDestroy` → the other hooks still run; the failures are collected into one
  `AggregateError`.
- Values (`provide(TOKEN, value)`) and test mocks have no hooks. Per-execution work is an observer,
  not a hook. `AfterAssemble` and the run-scoped `OnDestroy` are gone (#261).

## Options — every part replaceable

`createApp(Workflow, options)` and `createAppDeps(bundle, options)` take the same parts; anything not
given is the production default:

| Option                    | Default                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `env`                     | `dev` — the environment file to load ([Configuration](Configuration#environments))                      |
| `environment`             | the values of that file (give them directly instead)                                                     |
| `processEnv`              | `process.env` (provider keys, `fromEnv` variables)                                                       |
| `gateway`                 | the model providers of the workflow's `settings()` — the one model-call seam                             |
| `transport`               | MCP stdio / streamable HTTP from the server's config                                                     |
| `connectMcp`              | connect every server, check its contract (fail fast)                                                     |
| `stores`                  | `checkpointer` (memory), `ledger` (files), `terns` (SQLite) — given stores stay open on `close`          |
| `clock`                   | the system clock (the ledger's UTC day, Tern times)                                                      |
| `newThreadId`, `newRunId` | random UUIDs                                                                                             |
| `container`               | `overrides` (values instead of classes — test mocks), `onCreate`                                         |
| `pausedRuns`              | in memory, this app only (`createSqlitePausedRunRepository(path)` keeps them across restarts)           |
| `profile`, `profileRoot`  | none ([Profiles and comparisons](Profiles-and-comparisons))                                              |

`agboss/testing` builds its apps with these: a scripted gateway, stubbed MCP servers, memory
stores, a test clock, deterministic ids.
