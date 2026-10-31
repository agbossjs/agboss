# CLAUDE.md

Multi-agent project on LangGraph + LangChain (TypeScript). Built with a three-phase pipeline:
**triage → spec → implement**. Code is the only source of truth; tickets hold the reasoning.

## Stack

- Node 22+, TypeScript (strict, fully typed — see `QUALITY.md` → Types), ESM
- `@langchain/langgraph` (graph, and each agent's own loop as a subgraph), `@langchain/core`
  (messages, prompts, tools, test fakes), `zod` (inside the framework only — workflows use DTO
  classes, `@agboss/core/dto`)
- LLM access: **model providers** (#266) — `@ModelProvider` classes (`@agboss/core/models`) listed only in
  `@Application({ providers })`; none listed → the built-in `OpenRouterModelProvider` (chat) +
  `DecisionsModelProvider` (decision models), one listed → the list is complete. A workflow and its
  components name models only: every model of the application resolves to exactly one listed
  provider by `serves` at assembly (`[model.unserved]`, `[model.ambiguous-provider]`; one model
  through two providers = two model strings; the built-ins are catch-alls that yield a model another
  listed provider claims, #454); `agboss describe` prints `model: … → <provider>`.
  The built-ins are OpenRouter: their key is the `Secret` field `openRouterApiKey` of the
  application's environment (`secret("OPENROUTER_API_KEY")`; a provider's `apiKey` names its field),
  the base URL optionally its text field `openRouterBaseUrl` (`baseUrlField`;
  `env.optional("OPENROUTER_BASE_URL")` — unset → the decorator's `baseUrl`, no repeated default). Provider names end with `-model-provider` (`[name.kind-suffix]`).
  A **transport** provider (#385) `implements ModelProviderHandler` with `complete(request)` in
  place of `baseUrl` / `baseUrlField` / `apiKey` (both modes → a compile error and
  `[model-provider.both-modes]`; no `circuitBreakerPolicy` — a JS project or a cast — is
  `[model-provider.circuit-breaker-required]`, #521): `ModelProviderRequest` (`model`, `messages:
ModelProviderMessage[]`, `tools: ModelProviderToolDefinition[]`, `temperature`, `maxTokens`,
  `reasoning`, `promptCaching` — off when unset —, `signal`) → `ModelProviderResponse` (`text`,
  `toolCalls?`, `usage`, `cost?`, `finishReason?`), a failure thrown as
  `ModelProviderFailureError(ModelFailure.…, { retryAfter?, cause? })`; its `deps` injected by the
  application's container on its first call (one instance; `TenantContext` reads the calling
  execution; its `onInit` → `onStart` awaited before that call, once, a failure failing the call
  and retried by the next, `onStop` / `onDestroy` at `app.close()` only once created, #385 S4); `description`, `timeout`, `cost` required, `capabilities?` optional (absent → its
  settings are not checked). It is a `BaseChatModel` adapter (`TransportChatModel`), and every call
  of every provider goes through one attempt runner (`models/calls/attempt-runner.ts`: retries, the
  rate limit and its 429 pause, the breaker); a breaker's `fallback` is at the chat model
  (`FallbackChatModel`), HTTP ↔ transport either way.
  Policies per provider, app-wide (#266 PR 2): `retryPolicy` retries one call (the only backoff);
  `rateLimitPolicy: RateLimitPolicy.of({ maxConcurrentCalls, perMinute: { calls, tokens },
balancing })` — one limit for every execution, tenant and instance (`RateLimitRepository`), a
  call without room waits in a tenant-fair queue (`QueueBalancingStrategy`), a 429 pauses the whole
  queue for `Retry-After` on every instance and halves the instance's concurrency (back by one a
  minute); `circuitBreakerPolicy` — its state in `RateLimitRepository`, on the app's `Clock`. No
  `rateLimitPolicy` → no limit.
  - Routers: each `@Router` names its own `model` — a **decision model** (`DECISION_MODELS`: Jev,
    `openai/gpt-6-luna-decisions`, pplx-decider, Clef, …; OpenRouter Decisions API via
    `DecisionsModelProvider` — probabilities, exact cost) or any chat model. Guardrails use
    `defaults.guardrail.model` (Jev), never `defaults.router`. Judges on a decision model call `judgeModel.decide` with
    `Decision.noul` / `Decision.choice` / `Decision.score` / `Decision.image` (typed answers);
    `invoke` or `decide` on the wrong kind of model → `ModelKindError`.
  - Agents: cheap chat models (default `moonshotai/kimi-k2.6`) via `@langchain/openai`, each with
    `maxTokens` (`TokenLimit.MODEL_MAX` = model's maximum), `reasoning` (`Reasoning.on({ effort })`, `@agboss/core/models`), `cache`.
  - Everything is set in the workflow's components (`@Workflow` with its `flow` of paths,
    `@Router`, `@Agent`) and its application (`@Application`, its `@Budget`s) — reference: Architecture below (compiled by `make check`), then Wiki →
    Workflow, Routers, Components, Configuration (compiled by CI, see Quality gates).
- Observability: Langfuse tracing via env (`LANGFUSE_*` keys, loaded only when set). FinOps: built-in cost
  accounting; `@Workflow({ maxSteps })` and each node's `maxVisits` count steps, money is the
  application's `@Budget`s — per execution, per tenant and for the whole application per
  `BudgetPeriod` (UTC); an exhausted one rejects an execution before its first step or stops it
  with `BudgetExceededError`, unless an `.onError(…)` takes it (`QUALITY.md` → FinOps).
- Vitest (+ v8 coverage), ESLint (`typescript-eslint` strict), Prettier,
  `@langchain/langgraph-cli` for LangGraph Studio

## Commands

| Command (repo root)                    | What it does                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `make setup`                           | install dependencies (npm workspaces)                                                    |
| `make check`                           | **the gate**: build + API reports + compiled docs + format + lint + typecheck + coverage |
| `npm run dev`                          | rebuild the framework on change (watch)                                                  |
| `npm run check:docs`                   | typecheck the docs' ts blocks, check the commands they mention                           |
| `make smoke`                           | real-model smoke tests of the framework (needs `.env`), never in CI                      |
| `make fmt`                             | auto-format                                                                              |
| `npm run studio`                       | LangGraph Studio on flow-patterns (`agboss studio`: no `studio.ts` / `langgraph.json`)   |
| `scripts/langfuse.sh up\|down\|status` | local Langfuse for tracing; writes keys to `.env`                                        |

The CLI works on one application (#268): its path is set once in the project's `package.json` —
`"agboss": { "application": "src/flow-patterns.application.ts" }` — or given with `--application <path>`
(neither → exit 3 saying where to set it; there is no `--workflow <path>`). `chat`, `run`, `eval score`,
`replay`, `golden add` and `compare` run one workflow, chosen by its start's full name —
`--start chat-workflow-start` (optional with one start; with several and none given, or an unknown
name, exit 2 with the starts listed and a `Did you mean "…"?`, nothing runs); `run` takes a text
(`"<task>"`, a start taking `WorkflowStartTextDto`), `--input '<json>'` or `--input-file <file>`,
checked against the start's `InputOf` field by field before anything starts; `describe`, `check`
and `rag index [--rag <name>]` cover every workflow of the application. `eval` is made of subcommands
(#396 S4): `agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--env <name>]` runs an
`@EvalSuite` (found in the application's `eval-suites/*.eval-suite.ts`) on the application built as
`createApp` builds it — each case `--runs` times, its history written and its turns run on one thread
with the case's contexts, the checks under the cascade, pass@k / pass^k per case, `unstable` for pass@k
without pass^k — and writes the run artifact (`kind: "agboss.eval-run"`, `schemaVersion`; its types
`EvalRunReport` & co. public in `@agboss/core/eval`); `--baseline <run.json>` compares each case with the
same case of an earlier artifact (`CaseComparison`: `Regressed` = pass^k there and not now,
`FlakyOnBaseline` quarantined, `Changed` = another `caseHash`, not compared; `New`, `Removed`,
`Improved`, `Unchanged`), and with `--fail-on-regression` a regression is exit 5 (`quality`,
`eval.regressed`); `--profile <name>` runs it on a profile; the case's history turns are kept
`ExecutionRecordStatus.Written`, never scored by `eval score` nor saved by `golden add`; `agboss eval
score` is the Jev scoring of recorded runs (the bare `agboss eval` before, which now lists both and
exits 2); `agboss eval run … --html <file>` and `agboss eval show <run.json> [--html <file>]` (#397 PR 1)
render a run artifact — `show` reads a saved one, runs nothing — as its table and one self-contained
HTML page (inline style and script, no request, a CSP by hash; header, summary, the baseline diff
when the artifact has one, unstable cases with the node where their attempts part ways
(`attemptDivergenceOf`, `@agboss/core/internal`), cases with their expectation, attempt dots, each run's
checks and timeline — #397 PR 2: `schemaVersion` 2 adds each run's `trace` (`EvalExecutionTrace`,
the last turn's record cut down and masked: steps with `inputHash`, model calls, tool calls,
guardrail decisions, judge verdicts; handled errors, pauses, undo actions, children, the output) and
each case's `expectation`; version 1 artifacts are still read by the one reader `evalRunReportOf`; bounded at 16 MB — timelines of cases with pass^k left out first, then all, before `eval.report-too-large`; `eval.run-not-found`
/ `eval.run-invalid` for a file that is not an artifact this version reads), `agboss eval ui [--dir <folder>] [--port N]` (#397 PR 3) serves a folder of run artifacts read-only on
127.0.0.1 behind a token it prints (the `Host` checked; the runs, their attempts, each run's page;
`eval.no-runs` for a missing folder; #397 PR 4: a form per judge verdict writes a label — passed / failed, a
1–4 score, tags of `eval/failure-taxonomy.yaml`, a note — to `eval/labels/<suite>.jsonl`, the same run, judge and
labeler replaced, atomically, and the page's calibration is `calibrateJudges` on every load; a POST needs
the token in its form and the page's own origin; `eval.taxonomy-invalid`; #397 PR 5: "save as golden case" on a run
with an `executionId` drafts its kept execution — the record on the run's thread, of the run's `tenantId`
(#397 PR 5b) — (`--application`, `--env`: the history only, nothing runs) with
`evalCaseDraftOf` and `withEvalCase` — one builder with `generate eval-case` — and writes it into the suite's file
atomically, only while the file's ETag is the page's (else 409), never over a case of that name (409); an
application without `executionRecordRetention`, none at all or one that does not load turns the button into why) — a `schemaVersion` 3 artifact also names its `profile`,
`agbossVersion`, `models` and `piiPolicies` for the header, a version 4 each run's `tenantId` (#397 PR 5b); rendered in `agboss-cli`
(`src/eval/html/`, loaded on demand); `agboss eval calibrate --report <run.json> [--labels
<labels.jsonl>]` (#396 PR 4) reads a saved run's judges against people's labels (`EvalLabel`, one JSON
line each, `eval/labels/<suite>.jsonl` by default: `runId` `<case>#<run>`, `executionId`, `judge`,
`labeler`, `passed`, `score?` 1–4, `failureTags`, `note?`) — pairwise Cohen's κ (the judge with each
labeler, the labelers with each other), a confusion matrix per labeler, the disagreements and the
rubric (the judge's `metrics` keys over disagreements and agreements), `EvalCalibration` under
`--json`; runs nothing (`eval.labels-not-found` / `eval.labels-invalid`); `agboss compare` (and
`compareProfiles(Application, { start, profiles, tasks })`, on the workflow `start` opens) judges each
task's pair of answers in both orders (#396 PR 5) — agreeing verdicts are a win or a loss, anything
else a tie, a verdict for the same position both times also a `positionFlips`; `agboss eval run --chaos <rate> --chaos-seed <n> [--chaos-failures <list>]` (#396 PR 6) injects
`ChaosFailure`s (`rate-limited`, `timeout`, `truncated-response`) into the run's model calls at the
provider's HTTP client and a transport's `complete()`, under the retry policy, the rate limit and the
breaker, on the real budgets — seeded, the rate and the seed together; the artifact's `chaos`
(`EvalRunChaos`) says what was injected — the injection is an option of the internal build path
`eval run` uses (`builtApplicationOf`), never of `createApp`; `--metamorphic` (#396 PR 7) runs each
case's `variants` (its last turn reworded, on a thread of its own) and checks, as `metamorphic` after
the other checks under the cascade, that each calls the same set of tool classes as the case's last
turn and meets its `tools.required` again (the artifact's `metamorphic: true`; the `caseHash` covers
the variants only then); `agboss generate eval-case <name> --from-execution <executionId> [--suite
<name>] [--tenant <id>]` (#396 PR 8) drafts a case from a kept execution (#401) into its suite —
its input as the turn, its contexts, the thread's earlier finished turns as `history`, the calls it
ran as `tools.required`, masked as kept, its classes imported; the draft is `evalCaseDraftOf`
(`@agboss/core/internal`; `agboss eval ui`'s "save as golden case" calls it too, #397 PR 5); `agboss hub show <path…> [--html <file>]` (#401 PR 3,
`agboss-cli/src/hub/`) reads many applications' files — `describe --json` envelopes, `agboss.eval-run`
artifacts, `agboss.execution-record` exports, each by its marker (`hub.input-schema`,
`hub.duplicate-application`) — into the mesh: the applications, the calls between them seen in the
records (`remote` / `origin`, one per step `idempotencyKey`), each one's health from its records and
evals, the execution trees across applications stitched by each receiver's `origin` (#401 PR 4; a
missing receiver a stub), the crystallization radar — model steps ranked by spend × stability, the
share of the most frequent `steps[].decision` among calls with one `inputHash` (#401 PR 5: the step
record's `decision`, `route:` / `launch:` / `variant:` / `answer:<hash>`), a candidate at ≥ 50 calls,
≥ 0.95 and no failing eval —, one self-contained page in the eval report's shell; `agboss hub ui
<path…> [--port N]` (#401 PR 6) serves the same files read-only on `eval ui`'s server (`startLocalUi`,
its token, `Host` and CSP rules; `/records` search, `/api/mesh|applications|trees|records|radar|blast-radius`);
both draw each contract a snapshot declares as an edge consumer → producer and list `check --federation`'s
problems with their blast radius — the same `checkFederation` over each application's newest snapshot —
and who calls an application whose latest eval run lost pass^k (#401 PR 7); no project, nothing runs; `agboss check` assembles the suites too (`eval-suites` in its checks). `agboss dev` reruns `agboss
check` in a short-lived child on every change of the application's `src/` (debounced);
`agboss studio [--env <name>] [--port N]` builds every workflow (children too) with `studioOf`
(`@agboss/core/internal`), writes `.agboss/studio.ts` + `.agboss/langgraph.json` and starts `langgraphjs
dev` on them — a child is a subgraph inside its parent (S37); a project has no `studio.ts` /
`langgraph.json` of its own.
`agboss describe` (#268 PR 2)
prints the application's tree — the workflows it lists with their starts and the child workflows
they launch (`per item from vendor-finder-agent (maxItems 20, maxConcurrency 3)`, `ThisWorkflow,
recursive, maxDepth 3`) —, each contract's implementation and why, the model providers and why, each
channel (a role's question → answer, who answers, its reply interpreter and its implementation),
the budgets by scope and the execution budget of each workflow, then every workflow: its guardrails
and PII policies with their refusals (the text, or `ClassName.refusal()`), flow, each node's inputs
with their producers, each `about`, its limits (`maxSteps`, `maxVisits`, `maxDepth`,
`maxConcurrentExecutions`), `model → provider`, and each agent's compaction and `uncompactedTurns`
with where they came from (`(own)`, `(<workflow>)`, `(<application>)`, `(built-in)`). `agboss check` prints its report from the
decorators only (no `maxSpend()`): per start the worst case of one call — executions, at the same
time, agent and router steps of the tree, nesting depth — each with how it is made up; with `--env
<name>` the process variables that environment needs, names marked `value` / `secret` (`optional`,
`has a default`), never a value. `describe --json` / `check --json` carry the same as data;
`describe --json` is also each workflow's declarative snapshot (#268 S93): `configHash` (the one join
key — the same in `WorkflowRecord`, every execution event and the records), `starts`, `finishes`,
`nodes` (each with `kind`, `promptHash`, `schemaHash`, its `input` / `output` by DTO hash, an agent's
model, provider, reasoning, limits, memory, tools, knowledge bases, guardrails and PII policies in
effect, judges and instructions, a router's `decidedBy` and routes with `spawn` / `failure`), `edges`,
the `onError` table, `launches` (quorum, arbiters with their hashes) and `schemas` — every DTO by
class and every tool by name, each with its `schemaHash` and JSON Schema.

job-scout — resume → search brief → Greenhouse jobs ranked by Jev, the full example of a real
multi-step agent (chat, eval, golden, compare, a knowledge base, the Greenhouse probe) — left this
repository (#489, Wiki → ADR-0025-Examples-live-in-agbossjs-agboss-examples): it is
[`08-job-scout`](https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout) of agbossjs/agboss-examples, a standalone project on the published
`@agboss/core` whose `check`, `test` and `demo` scripts run offline at $0 in that repository's CI;
before a release the maintainer runs every example there against the candidate with real models
(`RELEASE_CHECKLIST.md` → Examples against the release candidate). Any run command takes
`--profile <name>` (`profiles/<workflow>/<name>.yaml`) and `--thread <id>`.

In `examples/flow-patterns/` (#295, the zero-cost harness of the public surface, #419; scripted tests,
no model key): `npm run check` (`agboss check --strict --cassettes` on its offline `src/desk.application.ts`
`--federation snapshots/` — its A2A export against its checked-in `describe --json`, its VCR
cassette `tests/desk/workflows/desk/__snapshots__/desk-lookup.cassette.json` (recorded offline through the transport,
#439; replayed by `tests/desk/workflows/desk/desk-cassette.test.ts`) against its prompts and schemas — and on its
application's twelve workflows `--federation` against the desk's fresh `describe --json`, then
`--models` on `test`, then `eslint .` with `@agboss/core/eslint`, then `npm run eval:check` — the desk's
eval suite run offline on `--env offline` against its baseline `eval/runs/desk-eval-suite.json`
with `--fail-on-regression`, `eval show --html` and `eval calibrate` on `eval/labels/`, then `npm
run records:check` — the desk keeps its executions (`executionRecordRetention`, #401, in
`.agboss/desk-offline.sqlite` on `offline`): one run, `agboss records export`, `agboss generate
eval-case --from-execution --dry-run` (#396 PR 8, what `eval ui`'s "Save as golden case" writes,
#397 PR 5); `npm run snapshot` rewrites the desk's describe, `npm run eval` its baseline) ·
`npm run describe`
(each of them: `src/offer/` the review loop, `src/credit/` a code router, `src/review/` parallel
launches in waves, #273, `src/panel/` a quorum with a code and a model arbiter, #279, `src/vendor/` a
child workflow per vendor, #263, `src/topic/` a workflow launching itself, #264, `src/approvals/` two
approvals at once through a `ThreadOwner` channel role answered in the terminal, #267, `src/hiring/`
an offer whose steps declare their undo, `compensateWith` / `committedBy`, #339, `src/travel/` two
bookings a failed join undoes automatically, #340, `src/desk/` the extension points — a custom
compaction, code guardrails, a tool interceptor — on a transport model provider that answers by the
request, and the operational contracts — a code judge on `toolCalls`, a `@Rag`, a `PiiPolicyHandler`,
an observer, a `@HealthCheck`, `maxConcurrentSteps` —, served over A2A (`@A2AExpose`, a caller
resolver) to `src/helpline/`, its consumer through an `@A2AAgent` contract (`a2aServer` in
`tests/desk/a2a/desk.a2a-expose.test.ts`, #398) that also reads policies through a stubbed `@McpServer` /
`@McpTool` (`mcpOf`), and an
`@EvalSuite` with a code eval judge (#396); `src/intake/` a quorum by groups (`joinQuorumGroups`,
tested under `TestConcurrency.inOrder` and `failWith(ModelFailure.RateLimited)`); the review loop's
reviewer reads `historyOf(OfferDraftDto)`; `tests/approvals/workflows/offsite-booking/offsite-booking.workflow.test.ts` resumes a pause on a second
instance (`testWith(App, { instances: 2, env: "instances" })`, one SQLite file);
every unit runner runs on the patterns' components in the test that mirrors each
(`tests/credit/routers/credit-limit/credit-limit.router.test.ts`, …), `src/model-providers/` beside the built-in OpenRouter, which yields `harness/…` to it, #382–#385, #454) · `npm test`.
Real runs (#346, its README: the manual checks #263 M1, #264 M1, #267 M1): `dev` reads
`OPENROUTER_API_KEY` (`openRouterBaseUrl` optional) and `PII_PSEUDONYM_KEY`, every store is SQLite,
Langfuse traces when its keys are set — `npx agboss run --start <name> --input '<json>'`, and
`npm run answer -- <pauseId…> [--decline]` answers waiting pauses from another process.

## Architecture

Everything below is checked against the code: every ` ```ts ` block of this file compiles against
the built package (`npm run check:docs`, with the generated `.agboss/types.d.ts` of its workflows),
and the worked example is assembled and run by script in the framework's tests
(`tests/docs/claude-md.test.ts`). If a block here is wrong, `make check` fails.

### A workflow, end to end

A workflow is a folder of components, one class per file, wired by a `*.workflow.ts` module whose
`flow` is a list of **paths** (#272, Wiki → ADR-0019-Flow-as-paths-with-path-scope); an
**`@Application`** (`*.application.ts`, #261) lists its workflows, its infrastructure and its
budgets, and is what `createApp` and `testWith` take, and what the CLI works on — its path set once
in `package.json` (`"agboss": { "application": "src/desk/desk.application.ts" }`), a workflow chosen
by its start (`agboss chat --start chat-workflow-start`, #268); `agboss check` writes `.agboss/types.d.ts`, which types the paths, every node's input and
`app.execute`. The shape every workflow follows — a support desk with one tool, one injected
service, one agent and a router:

```ts file=src/desk/tools/order-status.dto.ts
// tools/order-status.dto.ts — data crossing a tool boundary are DTO classes, one decorator per field
import { Text } from "@agboss/core/dto";

export class OrderQuery {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderInfo {
  @Text({ prompt: "where the order is" })
  status!: string;
}
```

```ts file=src/desk/services/order-book.service.ts
// services/order-book.service.ts — a service: does the I/O, created by the container
import { Injectable } from "@agboss/core";

@Injectable()
export class OrderBook {
  statusOf(orderId: string): Promise<string> {
    return Promise.resolve(`order ${orderId} shipped`);
  }
}
```

```ts file=src/desk/tools/order-status.tool.ts
// tools/order-status.tool.ts — `deps` lists the constructor's dependencies, in order (compiler-checked)
import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { OrderBook } from "../services/order-book.service.js";
import { OrderInfo, OrderQuery } from "./order-status.dto.js";

@Tool({
  name: "order-status-tool",
  description: "The status of an order",
  input: OrderQuery,
  output: OrderInfo,
  deps: [ExecutionContext, OrderBook],
})
export class OrderStatus implements ToolHandler<OrderQuery, OrderInfo> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly orderBook: OrderBook,
  ) {}

  async run({ orderId }: OrderQuery): Promise<OrderInfo> {
    this.executionContext.signal.throwIfAborted(); // the execution: executionId, threadId, step, …
    return { status: await this.orderBook.statusOf(orderId) };
  }
}
```

```ts file=src/desk/agents/support.agent.ts
// agents/support.agent.ts — the agent's own loop: its model, prompt and tools. No input/output:
// a text agent — it reads the message (WorkflowStartTextDto) and answers text
import { Agent } from "@agboss/core";
import { OrderStatus } from "../tools/order-status.tool.js";

@Agent({
  name: "support-agent",
  description: "Answers questions about orders",
  promptUrls: ["./support.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  tools: [OrderStatus],
})
export class SupportAgent {}
```

```md file=src/desk/agents/support.prompt.md
You answer questions about orders. Look every order up with order-status-tool; never guess a status.
```

```ts file=src/desk/workflow-starts/chat.workflow-start.ts
// workflow-starts/chat.workflow-start.ts — where a run starts: its input DTO
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class ChatWorkflowStart {}
```

```ts file=src/desk/workflow-finishes/chat.workflow-finish.ts
// workflow-finishes/chat.workflow-finish.ts — where a run finishes: its output DTO
import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

@WorkflowFinish({
  name: "chat-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ChatWorkflowFinish {}
```

```ts file=src/desk/workflow-finishes/hand-over.workflow-finish.ts
// workflow-finishes/hand-over.workflow-finish.ts — a second finish: the message, handed over as is
import { WorkflowFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowFinish({
  name: "hand-over-workflow-finish",
  description: "A message the desk does not answer, for the team",
  output: WorkflowStartTextDto,
})
export class HandOverWorkflowFinish {}
```

```ts file=src/desk/routers/main.router.ts
// routers/main.router.ts — `prompt` says how to choose, `routes` what each choice means, `input`
// what it decides on
import { DecidedBy, Router } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupportAgent } from "../agents/support.agent.js";
import { HandOverWorkflowFinish } from "../workflow-finishes/hand-over.workflow-finish.js";

@Router({
  name: "main-router",
  description: "Sends the message to the agent that answers it, or hands it over",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who handles the customer's message.",
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
  maxVisits: 1,
  routes: [
    { prompt: "Questions about orders", target: SupportAgent },
    {
      prompt: "Stop and hand the message over: it is not about an order",
      target: HandOverWorkflowFinish,
    },
  ],
})
export class MainRouter {}
```

```ts file=src/desk/desk.workflow.ts
// desk.workflow.ts — the module: the paths (`flow`), defaults, memory, providers; money: the application's budgets
import { Workflow, route, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupportAgent } from "./agents/support.agent.js";
import { MainRouter } from "./routers/main.router.js";
import { OrderBook } from "./services/order-book.service.js";
import { ChatWorkflowFinish } from "./workflow-finishes/chat.workflow-finish.js";
import { HandOverWorkflowFinish } from "./workflow-finishes/hand-over.workflow-finish.js";
import { ChatWorkflowStart } from "./workflow-starts/chat.workflow-start.js";

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto) // what the step put on the path: its scope
      .toRouter(MainRouter)
      .chooseOne(
        // one route per @Router route, each continued to its end
        route(SupportAgent)
          .toFinish(ChatWorkflowFinish),
        route(HandOverWorkflowFinish),
      ),
  ],
  defaults: { tools: { maxToolCalls: 4 } }, // over the application's
  uncompactedTurns: 5, // the last 5 turns of the thread in full, for its agent and its router
  maxSteps: 4,
  providers: [OrderBook],
})
export class DeskWorkflow {}
```

```ts file=src/desk/config/budget.config.ts
// config/budget.config.ts — every budget of the application, one template: what it limits, how much
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({
  name: "application-daily-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution }) // the default of every workflow
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}
```

```ts file=src/desk/desk.application.ts
// desk.application.ts — the application: its workflows, infrastructure (`providers`; none listed →
// the built-in in-memory defaults and the built-in OpenRouter + Decisions model providers), budgets,
// the defaults of every workflow and the environment contract (`environments/` next to this file)
import { Application } from "@agboss/core";
import { ApplicationDailyBudget, ExecutionBudget, TenantDailyBudget } from "./config/budget.config.js";
import { DeskWorkflow } from "./desk.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class DeskApplication {}
```

The test drives it by script — the whole application, no model, no network:

```ts file=tests/desk.test.ts
import { expect } from "vitest";
import { callTool, replyWith, routeTo, testWith } from "@agboss/core/testing";
import { DeskApplication } from "../src/desk/desk.application.js";
import { MainRouter } from "../src/desk/routers/main.router.js";
import { SupportAgent } from "../src/desk/agents/support.agent.js";
import { OrderBook } from "../src/desk/services/order-book.service.js";
import { OrderStatus } from "../src/desk/tools/order-status.tool.js";
import { ChatWorkflowStart } from "../src/desk/workflow-starts/chat.workflow-start.js";
import { ChatWorkflowFinish } from "../src/desk/workflow-finishes/chat.workflow-finish.js";

const test = testWith(DeskApplication); // the only form: testWith(DeskWorkflow) does not compile

test("an order question goes to support, which looks the order up", async ({ app, mockLlm }) => {
  mockLlm(MainRouter).thenReturn(routeTo(SupportAgent));
  mockLlm(SupportAgent).thenReturn(
    callTool(OrderStatus, { orderId: "7" }),
    replyWith("Order 7 has shipped."),
  );

  const result = await app.execute(ChatWorkflowStart, { text: "where is order 7?" });

  expect(result).toFollowPath([ChatWorkflowStart, MainRouter, SupportAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, { text: "Order 7 has shipped." });
});

test("a service is replaced by a mock", async ({ app, mockLlm, mockOf }) => {
  mockOf(OrderBook).statusOf.mockResolvedValue("order 7 lost");
  mockLlm(MainRouter).thenReturn(routeTo(SupportAgent));
  mockLlm(SupportAgent).thenReturn(callTool(OrderStatus, { orderId: "7" }), replyWith("Lost."));

  await app.execute(ChatWorkflowStart, { text: "where is order 7?" });

  expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
});
```

```ts file=vitest.config.ts
// vitest.config.ts — agbossTest() loads AGBoss through vite, in the test's module graph, and
// registers the workflow matchers (toFollowPath, toFinishWith, …)
import { defineConfig } from "vitest/config";
import { agbossTest } from "@agboss/core/testing/vitest";

export default defineConfig({ test: agbossTest({ include: ["tests/**/*.test.ts"] }) });
```

**Adding an agent** = its `agents/<name>.agent.ts` (+ `<name>.prompt.md`), one route in its
router's `routes`, and its path in the router's `chooseOne(…)` (`route(NewAgent).toFinish(…)`).
**Adding a tool** = `tools/<name>.dto.ts` + `tools/<name>.tool.ts`, listed in an agent's `tools`; a
service it needs goes in `providers`. `agboss generate <kind> <full name> --workflow <workflow's
full name>` writes and wires both, then regenerates the types (#268 AC8: `agboss generate agent
billing-agent --workflow desk-workflow`, `--agent billing-agent`; a name without its kind suffix is
rejected with a `Did you mean "…"?`, never completed; the workflow is found in the application of
`package.json`, or `--application`); `agboss generate workflow onboarding-workflow` writes a new
workflow beside the application file and lists it in `@Application({ workflows })`; `agboss create
<project>` writes the application (`src/<project>.application.ts`, its environments, budgets, model
provider and guardrail) and its first workflow `<project>-workflow` in `src/<project>/`. A project's `npm run types` (`agboss check`) writes
`.agboss/types.d.ts` (git-ignored, regenerated on install); its `tsconfig.json` includes it.

### The flow: paths

`@Workflow({ flow: [...] })` is a list of paths, each from a source to its finishes — built into
one LangGraph `StateGraph` and checked at assembly. A path reads left to right:

- **Sources:** `start(Start)` (where an execution begins); `agent(X)` / `router(R)` / `action(A)` /
  `workflow(W)` (#263) — the path of a node reached from two places (a review loop), written once.
- **Steps:** `.toAgent(X)`, `.toRouter(R)`, `.toAction(A)`, `.toFinish(F)`, `.toWorkflow(W)`
  (#263); `.returns(Dto)` says
  what the step before put on the path (its **scope**: later nodes read their `input` fields from
  it, `[input.missing-on-path]` when no path brings one) — one value per `.returns`, several as a
  chain `.returns(A).returns(optional(B))` (#299); `.chooseOne(route(X)…)` — the router's
  choice, one `route(…)` per `@Router` route; `.returns(oneOf(A, B)).switch(caseOf(A)…)` — a branch
  per variant of a `oneOf(…)` output; `.onError(ErrorClass, toAction(…)… | toAgent(…)… | toWorkflow(…)… | toFinish(…))` — the side
  path when the step before throws that class (its subclasses, or an error caused by it), written
  before the step's `.returns(…)`.
- **Parallel launches (#273):** `.toParallelAgents(A, B, B, { maxConcurrency })` /
  `.toParallelActions(…)` — each listed target runs once (a repeat is a copy), targets of that kind
  only; with one target right after `.returns(listOf(XDto))` it runs once per item (`{ maxItems }`
  required, `[launch.max-items-required]`; the target reads an `XDto` field, `[launch.item-not-read]`).
  A launch is followed by `.join()` (else it does not compile), then `.onJoinError(E, side path)`
  (never `.onError`), then `.join().returns(…)`: one value per class the branches give —
  `listOf(XDto)` for copies, two agents with one `output` and per-item runs, `optional(XDto)` for a
  router route that is `SpawnPolicy.OnDemand` or `FailurePolicy.Skip` — checked against the generated
  `JoinOutputs`; actions without `output` give nothing, so `.join()` goes on with `.to…(…)`. A branch
  sees the scope at the launch, its siblings' values only after the join; a branch renewing what a
  sibling read is `[launch.branch-outdates-sibling]` (#271). After `.toRouter(R)` the launch lists
  R's routes; a model router's routes state `spawn` (`[router.spawn-required]`, an `Always` route
  has no prompt, `[router.prompt-on-always]`), a code router's `route()` returns the `OnDemand`
  agents as a list. At run time (#273 PR 2) each branch is one LangGraph `Send` of one superstep;
  `maxConcurrency` is a sliding window (a branch frees its slot when it ends, fails or pauses); a
  per-item launch takes the first `maxItems` items in list order — never an error: `result.launches`
  (`{ launch, items, taken, branches }`, `BranchStatus`) and `onLaunchItemsTruncated` show it. A
  copy is `critic-agent#2` in `result.path`, traces and events (`step.copyNumber` from 1, a per-item
  run's `step.itemIndex` from 0; every run of one launch is one visit of its node, so all share its
  `visitNumber` and `maxVisits` counts launches); the join's lists keep listed / item order. A failed branch aborts
  its siblings (`FailFast`) and the join takes `.onJoinError(E, …)` (class and cause chain) or fails
  the execution with the branch's error; `FailurePolicy.Skip` drops only a `StepFailedError`, a
  limit in a `Skip` branch fails the launch, and `app.cancel` cancels the whole execution — never a
  branch outcome, never taken by `.onJoinError` (S21). A model router before a
  launch decides its `OnDemand` routes in one call — a `Decision.noul` per route on a decision
  model, one answer tool with a boolean per route on a chat model (tests: `decideWith({ "<target
name>": 0.9 })`); all no without an `Always` route → `RouterDecisionError` (S23).
- **Child workflows (#263):** a step may be an ordinary `@Workflow` of the application —
  `.toWorkflow(W)` (one child), `route(W)`, or `.toParallelWorkflows(W, { maxConcurrency, maxItems })`
  (one child per item, right after `.returns(listOf(ItemDto))`, `maxItems` required, then `.join()`).
  Each edge picks the child's start by class, never by name: a child with one start is entered
  through it; else the start with a required field of the item's type (per item) or of the chain's
  current value (the `.returns` / `caseOf` right before) — of several, the one whose other required
  fields are on the parent's path; none → `[graph.no-matching-start]` (the starts and their inputs
  listed), two → `[graph.ambiguous-start]` (fix: a subclass as one start's input) — both compile
  errors too, through the child's generated `Inputs` entry. `agboss describe` prints each edge's start.
  The child's scope starts with its start input only (`[input.missing-on-path]` per edge for the
  chosen start's required fields; its optional ones may be missing); its result is one of its
  finishes' outputs — `.returns(XDto)` for one class, `.returns(oneOf(…)).switch(caseOf(…)…)` with one
  case per class (two finishes of one class are one case; a case counts as read), and
  `.join().returns(listOf(oneOf(…)))` after a per-item launch (S53: one polymorphic list). Errors:
  `.onError(E, …)` right after `.toWorkflow(W)` or `workflow(W)`, `.onJoinError(E, …)` right after
  the join (the other does not compile). A per-item child with no finish reachable from one of its
  `.onError` side paths warns `[graph.child-without-failure-finish]` (an error under `--strict`).
  Any side path that can catch a `LimitExceededError` (the class, a subclass, a parent such as
  `AGBossError`) leads only to actions and finishes — `[graph.limit-handler-uses-model]`. A child
  may handle a failure too: `.onError(E, toWorkflow(W)…)` (S85), one more side-path starter. A
  child need not be listed in `@Application({ workflows })` — it belongs to its parent's
  application and runs alone through its own starts. At run time (#263 PR 2, S37; ADR-0022, #333
  PR 1) the child is a node of its parent whose subgraph is the child's compiled graph (Studio
  draws it inside) — a run of its own: its graph runs as a root graph on its own checkpoint thread
  `<parentThreadId>/child/<childExecutionId>` (never a thread of the API), awaited in its parent's
  step; the launching task's `checkpoint_ns` on the parent's thread holds only a marker (its
  identity and thread, `flow/runtime/child-thread.ts`); a child that rests at a pause makes its
  parent's node interrupt with a waiting marker (`child-own-thread.ts`, no pause), its pauses read
  through it and its answers forwarded by the node (`run/waiting-pauses.ts`, `run/resume-map.ts`);
  a child started before ADR-0022 (its whole state under its task) is continued that way, for one
  version (S4 D6). **On any instance (#333 PR 2–4, S6–S9):** `.toWorkflow(W, { placement:
ChildPlacement.AnyInstance })`, the same on `.toParallelWorkflows(W, { …, placement })` and
  `route(W, { placement })` (default `ParentInstance`; one class one placement,
  `[flow.conflicting-placement]`) — the parent's node queues the child in the application's
  `ChildExecutionQueueRepository` (`flow/runtime/remote/`) and waits inside its step on its row
  (woken in-process, else every second on the `Clock`; the parent yields its lease in
  `ExecutionLeaseRepository` while waiting and reclaims it before continuing, #333 PR 4 — yielded,
  not released: still its own there and renewed, so no other instance's sweep takes it over, #516);
  an instance with a free step slot (#332) claims it at once in-process, else at its sweep
  (`app/remote/child-workers.ts`), holds a 30 s lease under `(tenantId, childExecutionId)` in
  `ExecutionLeaseRepository`, runs it as a root graph on its own thread and completes the row —
  answered or failed, it finishes the lease (#520: `finish`, never taken again, so a stale instance
  that resumes takes no lease of finished work; a paused one releases it);
  a crash or a graceful stop past `shutdownTimeout` (S7) leaves the row `Running` so a live worker
  reclaims only that child once its lease is free and continues it from its last checkpoint;
  a cancel or the tree's end stops it at its next look (10 s). Its depth and the root's budgets are
  checked where it runs, and each superstep's spend is written to the root's counters at once
  (`isRecordedElsewhere`, #333 PR 3). A remote child that pauses completes its pass at `Paused` and
  interrupts the parent's node with `{ waitingForChild: { …, remote: true } }`, forwarding the
  child's resume map through the queue on `app.resume` (#333 PR 4); its failure's cause chain is
  kept as names, codes and messages (`RemoteChildFailure`). Its own `executionId`
  (kept in its marker — a pause, a restart or a crash continues it with the same id, no second
  `onExecutionStart`), its own path, steps and `maxSteps`, no thread history; it inherits the
  thread, `ownerId`, tenant and the execution's own fields, and spends from the root's budgets (a
  child's own execution budget applies only when it runs as the root). An uncaught error of its
  own — a step's failure, its `maxSteps`, a node's `maxVisits` — fails the parent's step with
  `ChildExecutionFailedError` (`step.child`, a `StepFailedError`: `cause`, `childExecutionId`,
  `itemIndex`, `workflow`), so its handler may be an agent; an exhausted budget or a cancel stops
  the whole execution as it is (S25). A paused child does not stop its siblings; its pause is the
  root's — in `result.pending` with its `childExecutionId` (and `itemIndex` per item), answered by
  `app.resume({ pauseId, decision })` like any other. `result.children`
  (and `result.record.children`) are the nested records — `ChildExecutionStatus`, start and input,
  finish and output or error, path, own spend, own `pauses` (the resolved pauses its own steps asked,
  #267 S124), own children; `result.handledErrors` the failures
  a side path took; observer events carry `parentExecutionId` / `rootExecutionId`.
- **Recursion (#264):** `ThisWorkflow` — a marker for the enclosing workflow (a decorator's
  arguments are evaluated before its class exists) — is a child like any other: `.toWorkflow(ThisWorkflow)`,
  `route(ThisWorkflow)`, `.toParallelWorkflows(ThisWorkflow, { maxItems })`, the node `this-workflow`
  (one class = one node; its own path `workflow(ThisWorkflow)…` from two places). It is the workflow's
  own compiled graph, run from the registry — never its own subgraph (Studio: the node
  `this-workflow`, marked `recursive: maxDepth N` in its `getGraphAsync` metadata). `@Workflow({ maxDepth })` is required (`[graph.recursion-without-depth]`);
  `executionContext.depth` is 1 at the root, each child record has its `depth`, the last level is
  `depth === maxDepth` — no model sees the depth, a domain level is an `input` field (`TopicDto.level`).
  The **soft stop** on the last level: of a branch (`.switch` / `.chooseOne`) the options whose path
  launches `ThisWorkflow` before the next branch are not offered — an agent's variants leave its
  response schema (a second cache prefix for that level), a model router's routes are hidden, a code
  router returning one is `RouterDecisionError`; each such branch keeps one that does not recurse
  (`[graph.recursion-without-exit]`). A launch decided by code or data past `maxDepth` does not start:
  `ChildExecutionFailedError` caused by `DepthLimitExceededError` (`limit.depth`: `workflow`,
  `maxDepth`, `depth`; a refused child record with an empty path) — `.onError(LimitExceededError, …)`
  right after the launch, `.onJoinError(…)` after a per-item join. Only direct recursion
  (`[graph.mutual-recursion]`, also for a class undefined by a circular import). Each level has its own
  `maxSteps`; the root's budgets count the tree. `agboss describe`: `recursive: ThisWorkflow, maxDepth
3, on the last level: researcher-agent → TopicReportDto only`, a list's producers `this-workflow ×0–5`.
  `ThisWorkflow` is typed per path (S112): a `.returns(…)` after a `ThisWorkflow` launch (any form, a
  side path's too) is a claim carried in the path's type up to `@Workflow({ name, flow })`, which
  checks it against the generated `ThisWorkflowOutputs[name]` (`input`, `output`, `join`) — a wrong
  class fails on `flow`; recursive workflows with different finishes live side by side.
- **The tree's concurrency cap (#264 PR 2, S27):** `@Workflow({ maxConcurrentExecutions })` of the
  root (default 10, a whole number from 1 — `[limits.max-concurrent-executions-invalid]`) — how many
  executions of the tree work at once. An execution holds a slot while one of its working steps
  (agent, router, action — a branch too; starts and finishes take none) runs; its parallel branches
  share it; at a join, while its child runs or paused it holds none. A step without a slot waits in the
  queue (no error): a parent closing its branch (its step right after its child or its children's
  join) first, then the deepest, `seconds(10)` of waiting = one level deeper (`AGING_STEP`, the
  `Clock`). Both a launch's `maxConcurrency` and the cap hold; a child's own smaller cap limits its
  subtree (a larger one → `[limits.child-concurrency-above-parent]`, a warning). A quorum's deadline
  excludes the time its branches wait for a slot (`QueueTime`). In-process (`TreeSlots` per `rootExecutionId`
  in `runtime/launch/launch-registry.ts`, made per pass; the claim `inTreeSlot` in `runtime/step-frame.ts`),
  or in `RateLimitRepository` (`SharedTreeSlots`, `tree:<tenantId>:<rootExecutionId>` and
  `:subtree:<executionId>`, renewed while held, polled on the `Clock`) when the tree can launch on
  any instance (#333 PR 3, S8): a resume or a recovery rebuilds the queue from the
  unfinished tasks; a waiter whose signal aborts (`FailFast`, a cancel) leaves it. `agboss describe`
  prints `maxConcurrentExecutions 6 (set)` for a workflow that launches children.
- **The instance's cap on steps (#332):** `@Application({ maxConcurrentSteps })` (a whole number from
  1, `[limits.max-concurrent-steps-invalid]`; unset → no cap) — how many agent, router and action
  steps (branches too) one application instance runs at once, over every tree and tenant. A step
  takes its tree's slot, then one of the instance's (`StepSlots`, `src/app/step-slots.ts`, one per
  `createApp`, loaded lazily) with the same claim and queue order (`runtime/launch/slot-queue.ts`:
  closing a branch first, then the deepest, aged on the `Clock`); never an error. A step waiting in
  a provider's rate-limit queue keeps its slot; a waiter at `app.close()` is interrupted at the
  shutdown timeout and recovered elsewhere. A full instance is `Degraded` in readiness (component
  `step-slots`, `HealthComponentKind.StepSlots`, `reason: "32 of 32 step slots busy, 7 steps
waiting"`) and its recovery sweep starts at most its free slots' worth of recoveries per look;
  `agboss describe` prints `maxConcurrentSteps 32 (set)` (`--json`: `maxConcurrentSteps`).
- **Quorums (#279):** after `.toParallelAgents(…)` a join may count answers instead of waiting for
  all — `.joinQuorum({ min, max, deadline })` (options always an object; `max` defaults to `min`,
  `deadline` in units: `seconds()`, `minutes()`, `hours()`) or `.joinQuorumGroups(group(A, B)
.priority(1).returns(…).to…(…), …, { deadline })`, where every group continues its own path (1
  is the highest priority; nothing follows the groups but `.onJoinError(E, …)`). `@Arbiter`
  classes (`arbiters/*.arbiter.ts`, `-arbiter`) decide whether an answer counts, attached with
  `.acceptedBy(X)` between the launch and the quorum (`.acceptedBy(…).join()` does not compile):
  several `.acceptedBy(…)` are an AND in path order, `.acceptedBy(anyOf(A, B))` stops at the first
  that accepts (S57). `decidedBy: DecidedBy.Model` — `model`, `prompt` and one `criteria` entry per
  agent of the launch; `DecidedBy.Code` — one `@OnAnswer(Agent) from<Agent>(answer: XDto): boolean`
  method per agent class (copy / item through `deps: [ExecutionContext]`); a missing one is
  `[arbiter.unhandled-agent]`, an extra one `[arbiter.unknown-agent]`, two `[arbiter.duplicate-agent]`.
  What `.returns(…)` may promise: the shape comes from the launch (a repeated class or a shared
  `output` → `listOf(XDto)` in every form); after `.joinQuorum({ min })` with `min` below the
  agents launched a single answer is `optional(XDto)` (a required one is
  `[flow.quorum-return-not-optional]`, also a compile error); a group's listed agents are required
  in its `.returns(…)`. `[flow.quorum-impossible]`: `min` above the agents (or `maxItems`), a group
  that can never complete. `agboss describe` counts a list's producers (`critiques: critic-agent
×1–2`). At run time (#279 PR 2, S26) the quorum is decided inside the launch's superstep: after
  each branch's agent its arbiter chain runs in the same slot and frame, then the answer is
  recorded at once — `BranchVerdict.Counted` (with its `acceptedSequence`, the join's order),
  `Rejected` (`rejectedBy`: the arbiters) or `Surplus` (accepted after the quorum was decided); once
  `max` is counted, a group has won, or the quorum can no longer be reached, the rest is cancelled
  (`BranchStatus.Cancelled`, a running check too). Under a quorum a branch's own step failure only
  leaves its place empty. `deadlineAt` is taken from the `Clock` at dispatch and kept in the
  launch's ticket (a pause counts as time); after a resume or a crash the quorum is rebuilt from the
  finished branches' records and an expired deadline cancels the rest without running them. The
  join decides from the records only: the counted answers (the winning group's own path), or
  `QuorumNotReachedError` (`step.quorum`) into `.onJoinError(…)`; an arbiter that throws or whose
  model does not answer is `ArbiterError` (`step.arbiter`), both `StepFailedError`s. A model
  arbiter makes one decision per answer under `arbiter:<name>` (tests: `mockLlm(Arbiter)
.thenReturn(decideWith({ counts: 0.9 }))`; a code arbiter is created by the container).
  `result.launches` (`isQuorumReached`, `group`, each branch's verdict) and
  `onQuorumDecided` (`QuorumDecidedEvent`) show it. `agboss generate arbiter <name>-arbiter
--workflow <name>-workflow [--agent <name>-agent]` writes a code arbiter for a launch.
- **Node kinds:** `@WorkflowStart` (input: a DTO, a list or a map of fields),
  `@Router`, `@Agent` (`input` fields, `output` — answered through answer tools, or text without
  them), `@Action` (code, no model: `execute(input)`; its execution through `deps: [ExecutionContext]`;
  `compensateWith: UndoAction` / `committedBy: CommitAction`, #339 — checked at assembly: the
  undo reads only what the path holds right after the action, `[action.invalid-compensator-input]`;
  an `.onError` / `.onJoinError` side path after it reaches a finish only through its undo, newest
  first, `[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`; with `committedBy` every
  path from it runs the committer or the undo, `[flow.uncommitted-action]`; `committedBy` without
  `compensateWith` has no effect, `[action.committer-without-compensator]`; `agboss describe`
  prints both. At run time (#340) each success opens a record in the execution's `compensations`
  (with a snapshot of what its undo reads) — committed by its committer or a finish (a child's own
  finish commits the child's), closed by its undo on a side path (`CompensationReason.SidePath`);
  a failed join undoes its finished undoable branches before `.onJoinError` or the failure
  (`JoinFailed`, newest first, after awaiting the launch's running branches), each in its own frame
  — key `<step key>:compensation`, `step.compensates`, a clean-up `signal` bounded by
  `@Application({ compensationTimeout })` (default `seconds(15)`) and a lost lease, no slot, no
  budget check; an undo that fails → the rest still run, then `CompensationFailedError`
  (`compensation.failed`, `failures`, `cause`), never taken by a side path; `result.compensations`,
  `onCompensationStart` / `onCompensationEnd`, `toHaveCompensated(A, { by, reason?, status? })`.
  An execution that ends without a finish (#340 PR 3) undoes its open records the same way, newest
  first, before it ends — `ExecutionFailed` for an uncaught failure or limit, `ExecutionCancelled`
  for a cancel or a launch's `FailFast`: a child in its parent's node before its error is raised, a
  root by the lease's holder after its pass fails (before its record is failed — `running` while
  the undo runs, #340 S7 —, its keys go and `onExecutionError`, whose `compensations` lists what
  ran), `app.cancel` of a paused tree after withdrawing its pauses and before it returns (an undo
  that failed → it rejects with `CompensationFailedError`), a cancel request (#360) found at lease
  take first; durable (#340 PR 4): `@agboss/unwinding` before a root's undo and
  `@agboss/compensated/<key>` after each success — the instance that takes the tree over
  (recovery, a resume) finishes the rest without a pass, a re-entered child its own before any
  step (`@agboss/unwinding:<childExecutionId>`); it awaits the tree's
  running step bodies up to `compensationTimeout` (one returning later is undone at once, in
  process), reads the records from the checkpoint and the instance's registry, writes the undo's
  spend to the ledger at once; `CompensationFailedError` passes a child's boundary as it is — the
  parent undoes its own), `@WorkflowFinish`
  (output DTO). `app.execute(Start, input)` is typed by the generated tables:
  `input` is the start's input, `result.output` the finishes' outputs.
- **Assembly rules** fail before any model call with **all** violations at once (`GraphRuleError`,
  stable codes `flow.*` / `graph.*` / `input.*` / `io.*` / `launch.*` / `router.*` / `arbiter.*` / `judge.*` / `eval.*`): names end with their kind
  (`-agent`, `-router`, `-action`, `-workflow-start`, `-workflow-finish`, `-workflow`) and are unique
  in the application (`[name.kind-suffix]`, `[graph.duplicate-node-name]`); DTO classes on paths
  end with `Dto` (`[dto.name]`); a path ends in a finish; a router's `chooseOne` lists exactly its
  routes (`[router.routes-mismatch]`); a node on a cycle has `maxVisits`. No field reads an outdated
  value — one built from an older version of what was renewed since (`[input.outdated-on-path]`,
  #271); in a cycle of classes built from each other the flow says what one value is about —
  `.returns(CritiqueDto, { about: DraftDto })`, or on a case `caseOf(ChangesRequestedDto, { about:
OfferDraftDto })` (`[io.ambiguous-cycle]`, #299); a node reads the earlier versions of a value as
  `historyOf(OfferDraftDto, { limit: 2 })` — `{ current, previous }` (no tags). At run time the scope holds
  current values only: a write moves the older value and everything built from it to
  `outdatedValues` (`result.record`, `outdated: { byValueId, reason: OutdatedReason… }`), one
  `onValuesOutdated` event per cascade (Wiki → Path-scope).

<!-- snippet-context
import { Action, Agent, VisitsLimitExceededError, Workflow, WorkflowFinish, WorkflowStart, agent, caseOf, start, toAction } from "@agboss/core";
import { Flag, Text, oneOf } from "@agboss/core/dto";

export class ShortlistDto {
  @Text({ prompt: "the shortlisted candidates" })
  candidates!: string;
}
export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}
export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}
export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
export class OfferSentDto {
  @Flag({ prompt: "the offer was delivered" })
  delivered!: boolean;
}
@WorkflowStart({ name: "offer-workflow-start", description: "A shortlist", input: ShortlistDto })
export class OfferWorkflowStart {}
@Agent({ name: "draft-agent", description: "Drafts the offer", prompt: "Draft the offer.", model: "moonshotai/kimi-k2.6", input: { shortlist: ShortlistDto }, output: OfferDraftDto })
export class DraftAgent {}
@Agent({ name: "reviewer-agent", description: "Reviews the draft", prompt: "Review the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto }, output: oneOf(ChangesRequestedDto, DraftApprovedDto) })
export class ReviewerAgent {}
@Agent({ name: "editor-agent", description: "Rewrites the draft", prompt: "Rewrite the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto, changes: ChangesRequestedDto }, output: OfferDraftDto, maxVisits: 2 })
export class EditorAgent {}
@Action({ name: "notify-recruiter-action", description: "Tells the recruiter", input: { draft: OfferDraftDto } })
export class NotifyRecruiterAction {
  async execute(): Promise<void> {}
}
@Action({ name: "send-offer-action", description: "Sends the offer", input: { draft: OfferDraftDto }, output: OfferSentDto })
export class SendOfferAction {
  execute(): Promise<OfferSentDto> {
    return Promise.resolve({ delivered: true });
  }
}
@WorkflowFinish({ name: "offer-failed-workflow-finish", description: "No offer", output: OfferDraftDto })
export class OfferFailedWorkflowFinish {}
@WorkflowFinish({ name: "offer-sent-workflow-finish", description: "Sent", output: OfferSentDto })
export class OfferSentWorkflowFinish {}
// @snippet
@Workflow({ name: "offer-workflow", version: "1.0.0", flow: offerPaths })
export class OfferWorkflow {}
-->

```ts
// a review loop: the reviewer is reached from the draft and from the editor — its path is its own
export const offerPaths = [
  start(OfferWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftAgent)
    .returns(OfferDraftDto)
    .toAgent(ReviewerAgent),

  agent(ReviewerAgent)
    .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
    .switch(
      caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
        .toAgent(EditorAgent)
        .onError(
          VisitsLimitExceededError, // the editor's maxVisits spent: tell the recruiter, finish
          toAction(NotifyRecruiterAction)
            .toFinish(OfferFailedWorkflowFinish),
        )
        .returns(OfferDraftDto)
        .toAgent(ReviewerAgent),
      caseOf(DraftApprovedDto)
        .toAction(SendOfferAction)
        .returns(OfferSentDto)
        .toFinish(OfferSentWorkflowFinish),
    ),
] as const;
```

<!-- snippet-context
import { Agent, DecidedBy, FailurePolicy, Router, SpawnPolicy, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { Flag, Text, WorkflowStartTextDto, listOf, optional } from "@agboss/core/dto";

export class CompanyDto {
  @Text({ prompt: "the company's name" })
  name!: string;
}
export class CompanyCheckDto {
  @Flag({ prompt: "whether the company passed" })
  passed!: boolean;
}
export class RankingDto {
  @Text({ prompt: "the companies, best first" })
  order!: string;
}
export class OrderStatusDto {
  @Text({ prompt: "where the order is" })
  status!: string;
}
export class RefundPolicyDto {
  @Text({ prompt: "the refund policy" })
  policy!: string;
}
export class LoyaltyOfferDto {
  @Text({ prompt: "an offer" })
  offer!: string;
}
export class CustomerReplyDto {
  @Text({ prompt: "the reply" })
  text!: string;
}
@WorkflowStart({ name: "screening-workflow-start", description: "What to look for", input: WorkflowStartTextDto })
export class ScreeningWorkflowStart {}
@WorkflowStart({ name: "support-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class SupportWorkflowStart {}
@Agent({ name: "screening-agent", description: "Finds companies", prompt: "Find them.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: listOf(CompanyDto) })
export class ScreeningAgent {}
@Agent({ name: "company-check-agent", description: "Checks one company", prompt: "Check it.", model: "moonshotai/kimi-k2.6", input: { company: CompanyDto }, output: CompanyCheckDto })
export class CompanyCheckAgent {}
@Agent({ name: "ranker-agent", description: "Ranks", prompt: "Rank.", model: "moonshotai/kimi-k2.6", input: { checks: listOf(CompanyCheckDto) }, output: RankingDto })
export class RankerAgent {}
@WorkflowFinish({ name: "ranking-workflow-finish", description: "The ranking", output: RankingDto })
export class RankingWorkflowFinish {}
@Agent({ name: "order-agent", description: "Looks the order up", prompt: "Look it up.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: OrderStatusDto })
export class OrderAgent {}
@Agent({ name: "refund-policy-agent", description: "Quotes the policy", prompt: "Quote it.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: RefundPolicyDto })
export class RefundPolicyAgent {}
@Agent({ name: "loyalty-agent", description: "Finds an offer", prompt: "Find one.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: LoyaltyOfferDto })
export class LoyaltyAgent {}
@Agent({ name: "answer-agent", description: "Replies", prompt: "Reply.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto, order: OrderStatusDto, refund: optional(RefundPolicyDto), loyalty: optional(LoyaltyOfferDto) }, output: CustomerReplyDto })
export class AnswerAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The reply", output: CustomerReplyDto })
export class SupportWorkflowFinish {}
@Router({
  name: "support-router",
  description: "Picks everyone needed",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick everyone needed for the customer's message.",
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: OrderAgent, spawn: SpawnPolicy.Always },
    { target: RefundPolicyAgent, spawn: SpawnPolicy.OnDemand, prompt: "The message is about returns" },
    { target: LoyaltyAgent, spawn: SpawnPolicy.Always, failure: FailurePolicy.Skip },
  ],
})
export class SupportRouter {}
// @snippet
@Workflow({ name: "launch-workflow", version: "1.0.0", flow: launchPaths, maxSteps: 60 })
export class LaunchWorkflow {}
-->

```ts
export const launchPaths = [
  // one agent per item of a list: its join gives one value per item
  start(ScreeningWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(ScreeningAgent)
    .returns(listOf(CompanyDto))
    .toParallelAgents(CompanyCheckAgent, { maxConcurrency: 3, maxItems: 50 })
    .join()
    .returns(listOf(CompanyCheckDto))
    .toAgent(RankerAgent)
    .returns(RankingDto)
    .toFinish(RankingWorkflowFinish),

  // a router decides who is launched; OnDemand / Skip routes give optional(…) values
  start(SupportWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toRouter(SupportRouter)
    .toParallelAgents(OrderAgent, RefundPolicyAgent, LoyaltyAgent)
    .join()
    .returns(OrderStatusDto)
    .returns(optional(RefundPolicyDto))
    .returns(optional(LoyaltyOfferDto))
    .toAgent(AnswerAgent)
    .returns(CustomerReplyDto)
    .toFinish(SupportWorkflowFinish),
] as const;
```

<!-- snippet-context
import { Action, Agent, StepFailedError, Workflow, WorkflowFinish, WorkflowStart, caseOf, start, toAction } from "@agboss/core";
import { Flag, Text, WorkflowStartTextDto, listOf, oneOf } from "@agboss/core/dto";

export class VendorDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;
}
export class VendorScoreDto {
  @Text({ prompt: "how well the vendor fits" })
  score!: string;
}
export class VendorRejectedDto {
  @Text({ prompt: "why the vendor is not a fit" })
  reason!: string;
}
export class VendorCheckFailedDto {
  @Flag({ prompt: "the check could not be done" })
  failed!: boolean;
}
export class VendorRankingDto {
  @Text({ prompt: "the vendors, best first" })
  order!: string;
}
@WorkflowStart({ name: "vendor-check-workflow-start", description: "One vendor", input: VendorDto })
export class VendorCheckWorkflowStart {}
@Agent({ name: "vendor-checker-agent", description: "Checks a vendor", prompt: "Check it.", model: "moonshotai/kimi-k2.6", input: { vendor: VendorDto }, output: oneOf(VendorScoreDto, VendorRejectedDto) })
export class VendorCheckerAgent {}
@Action({ name: "mark-vendor-failed-action", description: "Records a failed check", input: { vendor: VendorDto }, output: VendorCheckFailedDto })
export class MarkVendorFailedAction {
  execute(): Promise<VendorCheckFailedDto> {
    return Promise.resolve({ failed: true });
  }
}
@WorkflowFinish({ name: "vendor-scored-workflow-finish", description: "Scored", output: VendorScoreDto })
export class VendorScoredWorkflowFinish {}
@WorkflowFinish({ name: "vendor-rejected-workflow-finish", description: "Not a fit", output: VendorRejectedDto })
export class VendorRejectedWorkflowFinish {}
@WorkflowFinish({ name: "vendor-check-failed-workflow-finish", description: "Not checked", output: VendorCheckFailedDto })
export class VendorCheckFailedWorkflowFinish {}
@WorkflowStart({ name: "vendor-screening-workflow-start", description: "What to look for", input: WorkflowStartTextDto })
export class VendorScreeningWorkflowStart {}
@Agent({ name: "vendor-finder-agent", description: "Finds vendors", prompt: "Find them.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: listOf(VendorDto) })
export class VendorFinderAgent {}
@Agent({ name: "vendor-ranker-agent", description: "Ranks", prompt: "Rank.", model: "moonshotai/kimi-k2.6", input: { checks: listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)) }, output: VendorRankingDto })
export class VendorRankerAgent {}
@WorkflowFinish({ name: "vendor-ranking-workflow-finish", description: "The ranking", output: VendorRankingDto })
export class VendorRankingWorkflowFinish {}
// @snippet
@Workflow({ name: "vendor-screening-workflow", version: "1.0.0", flow: childPaths })
export class VendorScreeningWorkflow {}
-->

```ts
// the child: an ordinary @Workflow — one vendor, its own branches, a soft failure on its side path
@Workflow({
  name: "vendor-check-workflow",
  version: "1.0.0",
  flow: [
    start(VendorCheckWorkflowStart)
      .returns(VendorDto)
      .toAgent(VendorCheckerAgent)
      .onError(
        StepFailedError, // the child catches its own failure: one more class for its parent
        toAction(MarkVendorFailedAction)
          .returns(VendorCheckFailedDto)
          .toFinish(VendorCheckFailedWorkflowFinish),
      )
      .returns(oneOf(VendorScoreDto, VendorRejectedDto))
      .switch(
        caseOf(VendorScoreDto)
          .toFinish(VendorScoredWorkflowFinish),
        caseOf(VendorRejectedDto)
          .toFinish(VendorRejectedWorkflowFinish),
      ),
  ],
})
export class VendorCheckWorkflow {}

export const childPaths = [
  // one child per item: each VendorDto enters vendor-check-workflow-start; the join is the list
  // of the child's finish output classes
  start(VendorScreeningWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(VendorFinderAgent)
    .returns(listOf(VendorDto))
    .toParallelWorkflows(VendorCheckWorkflow, { maxConcurrency: 3, maxItems: 50 })
    .join()
    .returns(listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)))
    .toAgent(VendorRankerAgent)
    .returns(VendorRankingDto)
    .toFinish(VendorRankingWorkflowFinish),
] as const;
```

<!-- snippet-context
import { Agent, Arbiter, DecidedBy, OnAnswer, Workflow, WorkflowFinish, WorkflowStart, anyOf, group, start } from "@agboss/core";
import { Integer, Text, listOf, optional } from "@agboss/core/dto";
import { minutes, seconds } from "@agboss/core/units";

export class CandidateDto {
  @Text({ prompt: "the candidate" })
  name!: string;
}
export class ScoreDto {
  @Integer({ prompt: "the score, 1–10" })
  score!: number;
}
export class ScoreReviewDto {
  @Text({ prompt: "the review" })
  text!: string;
}
export class LegalReviewDto {
  @Text({ prompt: "the legal risks" })
  risks!: string;
}
export class CritiqueDto {
  @Text({ prompt: "an objection" })
  objection!: string;
}
export class FastScreenDto {
  @Text({ prompt: "why the deal is rejected" })
  reason!: string;
}
export class DealReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}
@WorkflowStart({ name: "candidate-workflow-start", description: "A candidate", input: CandidateDto })
export class CandidateWorkflowStart {}
@Agent({ name: "score-a-agent", description: "Scores skills", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreAAgent {}
@Agent({ name: "score-b-agent", description: "Scores risks", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreBAgent {}
@Agent({ name: "score-c-agent", description: "Scores the hire", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreCAgent {}
@Agent({ name: "score-summary-agent", description: "Sums up", prompt: "Sum up.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto, scores: listOf(ScoreDto) }, output: ScoreReviewDto })
export class ScoreSummaryAgent {}
@WorkflowFinish({ name: "score-review-workflow-finish", description: "The review", output: ScoreReviewDto })
export class ScoreReviewWorkflowFinish {}
@WorkflowStart({ name: "deal-workflow-start", description: "A deal", input: CandidateDto })
export class DealWorkflowStart {}
@Agent({ name: "legal-agent", description: "Legal review", prompt: "Review.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: LegalReviewDto })
export class LegalAgent {}
@Agent({ name: "critic-agent", description: "Objects", prompt: "Object.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: CritiqueDto })
export class CriticAgent {}
@Agent({ name: "fast-screen-agent", description: "Screens", prompt: "Screen.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: FastScreenDto })
export class FastScreenAgent {}
@Agent({ name: "full-review-agent", description: "Reports", prompt: "Report.", model: "moonshotai/kimi-k2.6", input: { legal: optional(LegalReviewDto), critiques: listOf(CritiqueDto) }, output: DealReportDto })
export class FullReviewAgent {}
@WorkflowFinish({ name: "deal-report-workflow-finish", description: "The report", output: DealReportDto })
export class DealReportWorkflowFinish {}
@WorkflowFinish({ name: "quick-reject-workflow-finish", description: "Rejected at once", output: FastScreenDto })
export class QuickRejectWorkflowFinish {}
// @snippet
@Workflow({ name: "quorum-workflow", version: "1.0.0", flow: quorumPaths })
export class QuorumWorkflow {}
-->

```ts
// arbiters/in-range.arbiter.ts — by code: one @OnAnswer(Agent) method per agent of the launch
@Arbiter({ name: "in-range-arbiter", decidedBy: DecidedBy.Code })
export class InRangeArbiter {
  @OnAnswer(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @OnAnswer(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @OnAnswer(ScoreCAgent)
  fromScoreC(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  private isInRange(answer: ScoreDto): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}

// arbiters/valid-score.arbiter.ts — by model: a criterion for every agent of the launch
@Arbiter({
  name: "valid-score-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: ScoreAAgent, prompt: "Gives a 1–10 score for technical skills, with a reason" },
    { agent: ScoreBAgent, prompt: "Names at least two concrete risks" },
    { agent: ScoreCAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class ValidScoreArbiter {}

export const quorumPaths = [
  // any two of three: the counted answers only, the third cancelled
  start(CandidateWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent)
    .acceptedBy(anyOf(InRangeArbiter, ValidScoreArbiter)) // the model only when the code rejects
    .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
    .returns(listOf(ScoreDto))
    .toAgent(ScoreSummaryAgent)
    .returns(ScoreReviewDto)
    .toFinish(ScoreReviewWorkflowFinish),

  // groups: the first complete one (by priority) continues its own path
  start(DealWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(LegalAgent, CriticAgent, CriticAgent, FastScreenAgent)
    .joinQuorumGroups(
      group(LegalAgent, CriticAgent)
        .priority(1)
        .returns(LegalReviewDto)
        .returns(listOf(CritiqueDto)) // critic-agent is launched twice: a list, even of one
        .toAgent(FullReviewAgent)
        .returns(DealReportDto)
        .toFinish(DealReportWorkflowFinish),
      group(FastScreenAgent)
        .priority(2)
        .returns(FastScreenDto)
        .toFinish(QuickRejectWorkflowFinish),
      { deadline: minutes(1) },
    ),
] as const;
```

- **Routers:** a route **to a workflow finish** is worded as a stop instruction
  ("Stop and send the answer: …"), never "the answer is ready". `decidedBy` names who decides
  (#280): `DecidedBy.Model` — the router's `model` (a decision model like Jev, or a chat model)
  picks a route from its `input`; `DecidedBy.Code` — the class's `route(input: InputOf<Self>)`
  (`implements RouterHandler<Self>`, `deps` like an action, the execution through
  `deps: [ExecutionContext]`) returns `Route<Self>`, the generated union of its targets — no model
  call, cost 0, a target outside `routes` does not compile. Options are discriminated by
  `decidedBy` (`model` / `prompt` / a route `prompt` on a code router do not compile); both kinds
  take `input` (non-empty, `[router.empty-input]`), `maxVisits` and, on routes, `spawn` /
  `failure` — options of a parallel launch (#273; defaults `Always` + `FailFast`, a code router's
  route `OnDemand`), an assembly error with `.chooseOne(…)` (`[router.policy-with-choose-one]`). A router that fails **fails the run** unless an
  `.onError(…)` right after it takes it: `RouterFailedError` (`step.router`: `route()` threw or
  the model call failed, the original as `cause` — `.onError(DomainError, …)` catches it through
  the cause) or `RouterDecisionError` (`step.router.invalid-decision`, a `RouterFailedError`: an
  answer outside its routes, never retried).
- `agboss describe` prints the flow in this grammar; Studio draws the same graph.

### Components and dependency injection

- **One class per file, folders by kind:** `workflow-starts/`, `routers/`, `agents/`, `actions/`,
  `workflow-finishes/`, `arbiters/`, `guardrails/`, `tool-interceptors/`, `compactions/`, `tools/`,
  `services/`, `mcp/`, `rag/`, `a2a/`, `environments/`, `eval-suites/` (#396); files `*.workflow-start.ts`,
  `*.router.ts`, `*.agent.ts` (+ `*.prompt.md`), `*.action.ts`, `*.workflow-finish.ts`, `*.arbiter.ts`,
  `*.guardrail.ts`, `*.tool-interceptor.ts`, `*.compaction.ts` (+
  `*.prompt.md`), `*.tool.ts`, `*.dto.ts`, `*.service.ts`, `*.server.ts` + `*.mcp.ts`, `*.rag.ts`,
  `*.helper.ts`, `*.eval-suite.ts`, `*.a2a-agent.ts`, `*.a2a-expose.ts`.
- **Decorator = metadata, constructor = dependencies, methods = a contract:** `implements` for your
  own (`ToolHandler<In, Out>`, `ActionHandler<Self>`, `RouterHandler<Self>`, `JudgeHandler<TReply>`,
  `RagConnector`), `extends` +
  `override` for a standard implementation (`McpServerClient`, `SqliteFtsConnector`). The check is
  on the decorator line, `implements` is documentation (#120 PR 4): every contract is a
  function-typed property (strict variance), so a method with a narrower parameter fails on
  `@Tool`, `@Rag`, `@Judge`, `@PiiPolicy`, `@ModelProvider`, … Prompts are
  `prompt` (inline) or `promptUrls` (files next to the component) plus `promptVariables`, normalised
  at load — no BOM, `\n` line breaks, no blank lines at the edges, NFC; parts joined with one blank
  line — and sent and fingerprinted as normalised;
  `{{variables}}` are checked at assembly (`[prompt.unknown-variable]`). What a node reads comes in
  its input message (`### field (from producer)`), never as `{{input.…}}` in instructions
  (`[prompt.input-in-instructions]`).
- **`deps`, one contract for every kind** (`@Injectable`, `@Tool`, `@McpTool`, `@Rag`, `@Judge`,
  `@Action`, a code `@Router`, `@InputGuardrail` / `@OutputGuardrail`, `@PiiPolicy`, `@Channel`): `deps` are checked
  against the constructor by the compiler and injected by the container. A token is a class or an
  `InjectionToken<T>`; values go in with `provide(TOKEN, value)` (a raw `{ provide, useValue }`
  does not compile). A dependency without a provider fails at assembly (`Consumer: "TOKEN" is not
registered …`); a class in `providers` without a decorator fails with `[di.undecorated-provider]`.
- **One container per application instance, no scopes (#261):** one instance per class (a class
  listed by two workflows is one instance), created at start. A dependency on a contract gets the
  one listed class that `extends` it (two → `[di.ambiguous-implementation]`); one token with
  different values → `[di.conflicting-values]`; no `new`: `provide(Class, …)` fails with
  `[di.instance-provider]`. Hooks, each optional: `implements OnInit, OnStart, OnStop, OnDestroy` —
  `onInit` (dependencies first) → `onStart` at start (a failure stops it, naming the component and
  the hook); `app.close()` → `onStop` (no new executions) → the running ones awaited → `onDestroy`
  (dependants first; failures collected into one error); from `app.close()` on `execute` / `resume`
  reject with `ApplicationStoppingError` (`app.stopping`).
- **Infrastructure (#261):** a framework contract with a built-in in-memory default, one per
  application — `CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
  LangGraph's `BaseCheckpointSaver`, and the contracts shared by instances (#265):
  `ExecutionLeaseRepository` (one lease per tree, `acquire` / `renew` / `release`, `yield` /
  `reclaim` — #516: a yielded lease stays its holder's, renewed, refused to others until it expires —,
  `finish` — #520: a release for good, the work under it over; no `acquire` of the key gets it again),
  `ExecutionTreeRepository` (`saveIfAbsent` / `findById` — the shared state of one request, removed
  when its tree ends), `RateLimitRepository` (slots as leases, windows and pauses — a provider's
  rate limit, 429 pause and circuit breaker, #266), `MeshRequestRepository` (the answers of trusted
  mesh requests by idempotency key, removed after `mesh.idempotencyRetention` by the recovery sweep,
  #398), `ChildExecutionQueueRepository` (#333 PR 2: children launched with
  `ChildPlacement.AnyInstance`, `saveIfAbsent` / `claimFirstByStatusQueuedOrderByDepthDesc` /
  `completeByTenantIdAndExecutionId`, rows removed with their tree; on the in-memory one
  `[application.in-memory-child-queue]`), `ExecutionHistoryRepository` (#401: each root execution's `ExecutionHistoryRecord` — its
  `ExecutionRecord` with `executionId`, `rootExecutionId`, `threadId`, `tenantId`, `application`,
  `workflow`, `status` (`ExecutionHistoryStatus`), `startedAt` / `endedAt`, `start` + `input`,
  `finish` + `output`, `contexts`, `error` — masked like its traces, saved when its tree rests or
  ends, only with `@Application({ executionRecordRetention })` (unset → nothing kept; on the
  in-memory store `[application.in-memory-execution-history]`), removed by the recovery sweep once it
  ended longer ago; `agboss records export (--tenant <id> | --all-tenants) --out <file.jsonl>
[--since] [--until]` writes it as JSON Lines, `kind: "agboss.execution-record"`, opening the stores
  only — `records.tenant-required`, `records.not-kept`), `ExecutionLeaseEventRepository` (#501: the
  lease log, append-only — `save`, `findAllByTenantIdAndRootExecutionIdOrderByOccurredAt`,
  `deleteByOccurredAtBefore`; `ExecutionLeaseEventRecord` = `LeaseTakeoverRecord` |
  `StepHandedOverRecord` (the step's `nodeId`, `visitNumber`, `idempotencyKey`) |
  `FencedEffectRecord` (`name`, `outcome`, the step, `writtenToken?`, `observedToken?`), identities and
  tokens only, masked like observer events; always written, whatever `executionRecordRetention` says,
  readable mid-run with `app.leaseEventsOf({ tenantId, rootExecutionId })`, removed by the recovery
  sweep after `@Application({ leaseEventRetention })`, default `hours(24)`; a kept
  `ExecutionHistoryRecord` carries its tree's rows as `leaseEvents`, so `agboss records export` does)
  — and the
  `@ModelProvider` classes (#266; an HTTP one is not created by the container, a transport one
  is — on its first call, #385; a misplaced one in a workflow's `providers` is
  `[di.infrastructure-in-workflow]` too). Listed **only** in
  `@Application({ providers })` (a class that `extends` the contract, `@Injectable`; in a workflow's
  `providers` → `[di.infrastructure-in-workflow]`), found by inheritance (two →
  `[di.ambiguous-implementation]`); `agboss describe` prints each contract's implementation and why
  (listed, or the built-in default), the budgets by scope and the count limits. Nothing is written to
  the home folder. Every contract has a
  ready SQLite implementation, enabled only by listing it (#265: `SqliteExecutionRecordRepository`,
  `SqliteCostLedgerRepository`, `SqlitePausedExecutionRepository`, `SqliteCheckpointSaver`,
  `SqliteExecutionLeaseRepository`, `SqliteExecutionTreeRepository`, `SqliteRateLimitRepository`,
  `SqliteMeshRequestRepository`, `SqliteExecutionHistoryRepository`,
  `SqliteChildExecutionQueueRepository`, `SqliteExecutionLeaseEventRepository`,
  `SqliteFencedEffectRepository`, `SqliteOutboundCallRepository`) —
  one `node:sqlite` connection per instance on the environment's `sqlitePath` (required only then,
  `[environment.missing-field]`; `:memory:` in tests), WAL + `busy_timeout`, atomic operations in
  `BEGIN IMMEDIATE`, time from the host's clock (`StoreClock`, #533: the test's clock in tests); flow-patterns' applications list seven of them. A project subclasses
  one through public tokens only, with `extends` + `override` and the class's own `deps` — `@Injectable({
deps: [SqliteConnection, Clock, ApplicationContext] })` (#265 S70); `SqliteExecutionRecordRepository`
  adds `IdGenerator` (`[SqliteConnection, Clock, ApplicationContext, IdGenerator]`, the in-memory one
  `[Clock, IdGenerator]`, #313). Every #265 store contract has `abstract ping(): Promise<void>`
  (#300: one fast round trip — the in-memory ones resolve, the SQLite ones `SELECT 1`; a project's
  own implementation adds it), what `app.checkReadiness()` calls. A store outside the core proves itself with
  the published contract suites (#481, `@agboss/core/testing/contracts`: `executionLeaseContract({
name, instance(seam), reset?, close? })`, one function per contract and the checkpoint saver),
  the same cases the in-memory and SQLite stores run — in one call, `storeConformance({ name,
reset?, stores: { executionLease, fencedEffect, outboundCall, executionLeaseEvent, rateLimit, … },
without? })` (#526 AC2: each claimed contract as `<contract> (<name>)` plus `store set (<name>)` —
  each fencing store's `static backend` declared, one with the set's lease store's — #542: and the
  leases its own contract ran on too —; a set with a lease
  store that leaves the fenced-effect, outbound-call or lease-log contract out, unless `without`
  says so, throws `StoreConformanceError` — `[store-conformance.missing-fencing-contract]`,
  `opted-out-store` (#543: a fencing store that declares `LeaseCheck.WithoutDoubleChargeProtection`
  fails every fencing case — a stale or expired lease refused, the zombie and lease races — and its
  `store set` case unless the call says `acceptWithoutDoubleChargeProtection: true`, which skips them
  with "store opted out of the lease check: no double-charge protection" and adds `gives NO
double-charge protection for …` — a fencing contract run on its own with the flag shows it in its own
  suite, failing `[store-conformance.opt-out-not-declared]` for a store that does not opt out —; every
  other case runs; the flag with no opted-out store fails),
  `lease-store-required`, `without-implemented`, `invalid-without`, `unknown-store` (#542: a key
  that names no contract), `empty`), which the core's own
  sets run (`tests/infrastructure/store-conformance.{in-memory,sqlite}.test.ts`, their targets in
  `tests/infrastructure/contracts/core-store-sets.ts`, `store-kinds.ts`); broken sets fail it
  (`tests/testing/contracts/broken-store-set.test.ts`: check-then-write, rows outside the
  transaction, a read-then-close `leaseStateOf`, a pre-#508 lease log, stores of no backend or
  another). Wiki → Your-own-store. Under real faults (#484): `faultSuite({ name, stores: "<module
path>", database: { url, reset }, timeScale?, scenarios? })` (`@agboss/core/testing/faults`, an
  entry of its own, never loaded by the root) runs the fixture application (`src/testing/faults/
fixture/`: reserve with an undo, a fenced charge, a payment through `OutboundCalls` to the test's
  gateway, a batch of `AnyInstance` children) in real `node` pods on one database (the module
  exports `faultStores`: providers, environment, business rows), with SIGTERM / SIGKILL / SIGSTOP /
  SIGCONT and a TCP proxy per pod (a file database: a store outage), 20 scenarios (#533: `s13-clock-ahead`
  / `s13-clock-behind` — a pod's clock ten leases off, `FaultPodOptions.clockSkew`; a pod's stores keep
  the run's time)
  (`tests/faults/s*.test.ts` on SQLite at `timeScale` 10, the `faults` vitest project, one file
  at a time), each checked by `faultViolationsOf` — `one-owner`, `finished-work-untouched`,
  `children-once`, `effects-once`, `no-undo-on-hand-over`, `trees-finish` — from the public API
  and the run's `OperationHistory` (every held store operation's invoke and complete, monotonic
  time); `withHoldPoints(Store)` (`StoreHoldPoint`, `processHoldPoints`) holds any store's
  operations before or after the store, the way scenarios force orders across processes; broken
  stores fail the scenario they target (`tests/faults/sabotage.test.ts`). Wiki →
  Guarantees-across-processes. On the public surface alone
  (#511): every store call of a target is tracked on the case's `VirtualClock` (`clock.track`), so
  `advance` lets a database round trip finish; the checkpoint saver's `put` is given the versions
  LangGraph passes, so LangGraph's own savers (`MemorySaver`, `PostgresSaver`) pass as they are;
  every type a contract's members name is exported by the root entry (`Tern`, `ExecutionData`, …,
  `tests/public-api/contract-types.test.ts`), with `totalCost(records)`, the sum a ledger adds
  (#521); every text and JSON value a store is handed comes back unchanged, a NUL character
  (U+0000) included — a NUL case in each JSON-storing suite (#521: the SQLite record store keeps
  free text as JSON text, migration 14; PostgreSQL's `jsonb` / `text` need JSON as text); a test
  signs mesh envelopes as a peer with `signedMeshEnvelope({ issuer, signingKey, body, issuedAt,
origin, callChain, … })` (`@agboss/core/testing`, the real client's header); and a class declares the environment fields it reads —
  `@Injectable({ deps, environmentFields: { postgresUrl: EnvironmentField.Secret, postgresPoolSize:
EnvironmentField.OptionalInteger } })` — checked at assembly for every class the application or
  a workflow lists and every class their `deps` reach: a required one the contract lacks is
  `[environment.missing-field]` (`… needs postgresUrl: Secret in AppEnvironment (read by
PostgresConnection)`; `SqliteConnection` declares `sqlitePath` so), one field of two types
  `[environment.conflicting-field]`.
- **Time is the application's `Clock` (#262):** infrastructure too — `now()` and
  `sleep(delay, signal?)`; the system's unless `@Application({ providers })` lists a class that
  `extends Clock` (created first: it may not depend on the contexts, whose `startedAt` it gives).
  Every time read and wait of the framework goes through it — the ledger's day, records, leases and
  their renewals, the recovery sweep, the shutdown timeout, a tool's `timeout`, a model call's
  timeout, retry backoff and `Retry-After` pauses; a component that needs the time injects it
  (`deps: [Clock]`). Lint `agboss/no-direct-time` fails `Date.now()`, `new Date()` / `Date()`
  without arguments, `performance.now()`, `setTimeout`, `setInterval`, `AbortSignal.timeout` and
  `node:timers` in `packages/agboss/src` (the real implementation, `src/infrastructure/clock.ts`,
  excepted) and in a project's `src/` outside its tests (the `eslint.config.js` `agboss create`
  writes, #388).
- **Ids are the application's `IdGenerator` (#313):** infrastructure like the `Clock` (and in its
  module) — `newThreadId()` and `newExecutionId()`; every thread id the framework mints
  (`app.execute` without a `threadId`) and every execution id (roots, children, recursion levels)
  comes from it; a caller's own `threadId` is used as given, a recovered execution keeps its id. The
  built-in `RandomIdGenerator` (random UUIDs, the formats before #313) unless
  `@Application({ providers })` lists a class that `extends IdGenerator` (two →
  `[di.ambiguous-implementation]`, in a workflow's `providers` → `[di.infrastructure-in-workflow]`);
  created before the stores that inject it, so it may not depend on the contexts. Never a `pauseId`
  (an answer credential: a random 128-bit token) and never a model call's id (the provider's).
- **Defaults cascade (#261):** `@Application({ defaults })` → `@Workflow({ defaults })` → the
  component's own field, merged field by field — the most specific level that sets a field wins,
  nothing set → the built-in. `defaults.router.model` is the model of `DecidedBy.Model` routers
  without their own (`[router.no-model]`), `defaults.guardrail.model` the guardrails' — separate, a
  guardrail never takes the router's (`[guardrail.no-model]`); `agboss describe` shows each router's
  and agent's value and where it came from (`(own)`, `(desk-application)`, `(built-in)`).
- **Components keep no state:** another instance may continue an execution after a pause, so a
  component reads the execution from `ExecutionContext`, data that outlive a step live in the graph
  state, caches and deduplication are your own service over external storage. Lint
  (`agboss/no-component-state`) flags `this.x = …` outside the constructor of any component.

<!-- snippet-context
import { Injectable } from "@agboss/core";
interface RedisClient {
  sAdd(key: string, member: string): Promise<number>;
}
@Injectable()
export class RedisClientProvider {
  readonly client: RedisClient = { sAdd: () => Promise.resolve(1) };
}
// @snippet
-->

```ts
@Injectable({ deps: [RedisClientProvider] })
export class SeenJobsRepository {
  constructor(private readonly redisClientProvider: RedisClientProvider) {}

  async markSeen(executionId: string, jobId: string): Promise<boolean> {
    const added: number = await this.redisClientProvider.client.sAdd(`seen:${executionId}`, jobId);
    return added === 1; // the state lives in Redis: any instance continues the execution
  }
}
```

- **Data are DTO classes** (`@agboss/core/dto`): `@Text`, `@Integer`, `@Flag`, `@OneOf`,
  `@ListOf`, `@Nested`, …; plain data, no methods; on paths wrapped as `listOf(Dto)`,
  `oneOf(A, B)`, `optional(Dto)`, `historyOf(Dto, { limit })` (an input: the current value and the
  earlier versions), `variant(Dto, value)`. Standard ones: `WorkflowStartTextDto`,
  `WorkflowFinishTextDto`, `ToolCallApprovalDecisionDto`, `RagSearchResultDto`, `PlainTextDto`
  (Wiki → Standard-DTOs). zod stays inside the framework.
- **Tool names** (#268 AC9): a project's `@Tool` / `@McpTool` is named like every component —
  kebab-case ending with `-tool` (`order-status-tool`, `[name.kind-suffix]`); a knowledge base's
  tool is `search-<rag name>-tool` (`search-jobs-rag-tool` for `jobs-rag`); an MCP server's own
  tools keep the server's names (`read_text_file`, in `@McpServer({ tools })`). Every name a model
  sees fits `[a-zA-Z0-9_-]`, at most 64 characters (`[tool.name-too-long]`, `[tool.name-invalid]`),
  and is unique over local, MCP, knowledge-base and answer tools (`answer-<dto>`) — else
  `[tool.duplicate-name]`. A tool's `timeout` has units: `@Tool({ timeout: seconds(5) })` (default
  30 s; there is no `timeoutMs`). What a model reads of one result is bounded (#336):
  `maxResultSize: kilobytes(256)` on `@Tool` / `@McpTool`, else `defaults.tools.maxResultSize`
  (application → workflow), else 128 KB, in bytes of UTF-8 — a longer rendered result (an error's,
  a knowledge base's search or context block too) is cut before PII masking with
  `\n[result truncated: N bytes, the first M kept]` (`onToolEnd`'s `isResultTruncated`;
  `[tools.max-result-size-invalid]`).
- **Tool interceptors (#384):** `@ToolInterceptor({ name, description, deps? })`
  (`tool-interceptors/*.tool-interceptor.ts`, `-tool-interceptor`) — a class that implements
  `BeforeToolCall`, `AfterToolCall` or both (neither does not compile,
  `[tool-interceptor.missing-handler]`), listed in `toolInterceptors` of `@Application` →
  `@Workflow` → `@Agent` → `@Tool` / `@McpTool` (lists add up, outer first; `excludeToolInterceptors`
  on an agent or a tool removes an inherited one, `[tool-interceptor.exclude-not-inherited]`,
  `[tool-interceptor.not-an-interceptor]`). Runs in the tool call's frame (`step.callId`, its key and
  signal), after the arguments' PII block rules: `beforeToolCall({ tool, input })` — arguments
  revealed, not validated — outer first, `ToolCallDecision.allow()` / `.replyToModel({ message })`
  (the tool is not called, the model reads `message` as its result, bounded and masked, the step
  goes on) / `.block({ reason })` (the step fails with `ToolBlockedError`, `step.tool-blocked`, a
  `StepFailedError`: `agent`, `tool`, `interceptor`, `reason`); `afterToolCall({ tool, input,
output })` on a successful result, inner first, each output validated against the tool's output —
  then `maxResultSize` and PII masking. One that throws, decides nothing or gives a wrong output
  fails the step (`AgentFailedError`, its error the `cause`). Never on answer tools, knowledge-base
  search tools or a tool called on its own. `agboss describe` prints `tool interceptors`, `--json`
  each agent's chains by tool, `configHash` covers them; `testToolInterceptor(I, options)` →
  `beforeToolCall(Tool, input)` / `afterToolCall(Tool, input, output)` → `{ output, spend }`.
- **Channels (#267)** are found through the tools that name them (`@Tool({ channel })`), like
  services through `deps` — there is no `channelClasses`. A tool names a concrete `@Channel` (used as
  is: `TerminalUserChannel`, `AutoApproveChannel`, …) or a **role**: a project's abstract class
  `@ChannelRole({ name, description, approves: XDto | ask + answer, answeredBy: PauseAnswerer.… })`
  that `extends ChannelOf<Self>` — `answeredBy` is required, `approves` must be the tool's input
  (`[channel.wrong-tool]`), one `replyInterpreter` belongs to one role
  (`[channel.shared-interpreter]`). Its one implementation (`@Channel`, `extends` the role) is
  listed in `@Application({ providers })` — channel transport is infrastructure, never a workflow's
  provider; none → `[di.missing-implementation]`, two → `[di.ambiguous-implementation]`. A channel has
  one method, `send(ask: ChannelAsk<Role>): Promise<ChannelOutcome<Role>>` (`ask = { pauseId, value }`,
  typed by the generated `ChannelRoles`): `ChannelOutcome.awaitReply()` pauses the execution until
  `app.resume({ pauseId, decision })`, `ChannelOutcome.decided(decision)` goes on at once (validated
  like a reply, its record closed at once: `Taken`, `PauseResolution.Decided`). The `pauseId` is made
  once per pause, before the first `send` — a retried `send` gets the same one (the channel's
  idempotency key); a concrete `@Channel` named as is (`TerminalUserChannel`) is answered by the
  thread's owner. **Free-text replies (#267 PR 3):** a role's `replyInterpreter` is a
  `@ReplyInterpreter` (`-reply-interpreter`, one per role) that reads `app.resume({ pauseId, reply })`
  with the pause's question — `{ ask, reply }` — into the role's answer, validated like a decision:
  `DecidedBy.Model` (a chat model, one answer tool, static `prompt` / `promptUrls`; for an approval
  role a decision model too — approve / refuse only, one `Decision.noul("approved")`, P(yes) > 0.5,
  no `reason` / `overrideArguments` (#267 S124); a question role on a decision model is
  `[reply-interpreter.decision-model]`; the call checked against the tree's budgets, counted in their
  ledger at once and in the execution's spend when its step takes the answer, traced as
  `reply-interpreter:<name>`) or `DecidedBy.Code` (`implements ReplyInterpreterHandler<Self>` —
  `interpret(input: InputOf<Self>)` returns `ReplyInterpretation.understood(decision)` or
  `ReplyInterpretation.notUnderstood({ reason })` (sync or a promise; a plain object does not
  compile; a `throw` is a crash only), `deps`, created by the container). Either kind reads in the pause's execution frame (its `ExecutionContext`:
  tenant, owner, the waiting step — the rate limits see the tenant); a model one reads the question
  and the reply through the application's and the workflow's PII policies, its answer revealed before
  validation (an unknown token is a decline, a block rule `PiiRefusedError`). Unreadable (not
  understood, no answer, an invalid one, a crash) → `UninterpretableReplyError`
  (`pause.uninterpretable-reply`, `reason`, `cause` when an error is behind it), the
  pause stays pending; a role without one → `ReplyInterpreterMissingError`
  (`pause.no-reply-interpreter`); `[reply-interpreter.not-an-interpreter]`,
  `[reply-interpreter.no-interpret-method]` at assembly.
- **Observers are registered only in `@Application({ observers: [...] })`** (#261), not discovered
  and never in `@Workflow`: typed hooks (`implements OnToolEnd, …`), one instance each, called for
  every execution of the application (filter by `event.workflow.name === nameOf(W)` — `nameOf(C)`
  is the `name` of any decorated class); an observer with no or a
  misspelled hook fails assembly (`[observer.no-hooks]`, `[observer.unknown-hook]`), one that throws
  is a warning in the log (`observer.failed`). One event object per hook, plain data, never the
  internal state: every execution event (`ExecutionEvent`) has `executionId`, `parentExecutionId`,
  `rootExecutionId`, `threadId`, `tenantId`, `workflow` (`WorkflowRecord`: `name`, `version`,
  `startedVersion`, `configHash`, no class); node events (agent, router, tool, model, knowledge base, guardrail,
  action, channel, judge, `onValuesOutdated`, `onLaunchItemsTruncated`,
  `onQuorumDecided`) add `step`
  (`StepRecord`: `component` — its `ComponentRecord`, `{ name, kind, promptHash, schemaHash }`,
  the join keys of `describe --json` (#268 S93) —, `nodeId`, `visitNumber`, `copyNumber`,
  `itemIndex`, `idempotencyKey`, `callId`, `toolLoopIteration` (an agent's model call in the visit,
  from 1, during it and its move's tool calls), `validationAttempts` (its answers and tool arguments
  that failed validation so far)). Execution hooks: `onExecutionStart` once per execution,
  `onExecutionPause` (`pending`, when nothing else can move — again after a partial resume) /
  `onExecutionResume` (`reason: ResumeReason`, `decision`, `answeredBy`) around a pause,
  `onExecutionEnd` once when it ends at a finish (`finish`, `spend`), `onExecutionError` when it
  fails — also after a resume (a cancelled paused one: `ExecutionCancelledError`). A request refused
  before an execution starts or is located (another owner's thread, an unknown or answered pause,
  an unknown thread, invalid input, an exhausted budget) → `onExecutionRejected` (`operation:
ExecutionOperation`, `threadId?`, `tenantId`, `code`, `message` without input values, no
  `executionId`), still thrown; `IncompatibleResumeError` → `onExecutionError` on the paused
  execution, which stays paused. `onValuesOutdated` (`trigger`, `outdated` — no DTO values) once
  per outdating cascade, never empty; `onLaunchItemsTruncated` (`launch`, `items`, `maxItems`) when
  a per-item launch dropped items (#273); `onQuorumDecided` (`launch`, `isReached`, `branches`,
  `group`) once per quorum (#279). `onExecutionLeaseTakeover` (#501, `ExecutionLeaseTakeoverEvent`:
  `tenantId`, `rootExecutionId`, `leaseExecutionId`, `scopeKey`, `token`, `holderInstanceId`,
  `previousHolderInstanceId?` / `previousToken?`, `checkpointId?`, `reason: LeaseTakeoverReason` —
  no workflow, like a rejection) once per takeover of a tree's lease, its row of the lease log written
  first; `onStepHandedOver` (#501, `StepHandedOverEvent`, a node event: `reason: HandOverReason` —
  `LeaseLost` / `Fenced` / `ApplicationStopping` —, `site: HandOverSite` — `Step`, `Tool`,
  `ToolInterceptor`, `Compensation`, `Branch`, `Child` —, `scopeKey`, `holderInstanceId`, `token`,
  `observedToken?`) once per hand-over error and lease scope, at the innermost site that found it
  (`recordedHandOver`, `src/app/handed-over.ts`), its row written before the lease is released;
  `onFencedEffect` (#501, `FencedEffectEvent`, a node event: `name`, `scopeKey`, `token`, `outcome:
FencedEffectEventOutcome` — `Ran` / `Replayed` / `Joined` / `Refused` —, `writtenToken?`,
  `observedToken?`, never the result) once per call of `FencedEffectRepository.saveResultIfAbsent`
  from a step, in the lease's order (a refusal before the hand-over it causes).
- **The framework's log (#261):** the `Logger` contract is infrastructure (`ConsoleLogger` — one
  line per entry on stderr — unless `@Application({ providers })` lists an `extends Logger`; silent
  in tests unless listed). At start, once, only what the decorators say: what started and the worst
  case of one call of each start, then the startup warnings — no `maxSpend()`, nothing per tenant;
  while running only problems (`LogLevel.Warn` / `Error`, a stable `code`, `executionId` /
  `tenantId`). Assembly warnings — tenant or application budgets on the built-in in-memory ledger
  (`[application.in-memory-cost-ledger]`), possible pauses on in-memory paused executions or
  checkpoints (`[application.in-memory-pauses]`), children on any instance on the in-memory child
  queue (`[application.in-memory-child-queue]`), PII tokens on a key of the instance — no
  `@Application({ pseudonymKey })` (`[application.pii-instance-key]`, #120 S94) — are in
  `app.warnings` and the start log, errors under `agboss check --strict`, silent in tests.
- **Memory and compaction (#120 PR 3):** a turn of a thread is a finished root execution
  (`start <name>: <input>` / `finish <name>: <output>`); each agent and model router sees its last
  `uncompactedTurns` in full, as a message of its own — one setting on `@Application` →
  `@Workflow` → `@Agent` / `@Router` (the lowest set value wins; default 5, `TurnLimit.ALL` = every
  turn; on a code router it does not compile, `compaction` neither). What is older is a
  `@Compaction`'s (`compactions/*.compaction.ts`, `-compaction`), named by `compaction: X` on the
  same levels (the lowest set wins; none anywhere → the window only): `CompactionStrategy.SummaryQueue`
  — every `turnsBetweenCompactions` turns older than the window become one self-contained summary,
  the latest `summaryQueueLength` kept; `SingleSummary` — one summary, rewritten from the previous
  one and the new turns; `None` — no model, no prompt, no parameters (a type error otherwise, as a
  missing `model` is for the other two); `Custom` (#382) — the class `implements CompactionHandler`:
  `compact({ previousSummaries, turnsToCompact })` (each a `CompactionTurn`: `startName`, `input`,
  `finishName`, `output`, masked like a model's input) returns the summaries readers see from now
  on, its services through `deps` (created by the container, run in the frame of the execution's
  start); `turnsBetweenCompactions` only — no `model` / `prompt` / `summaryQueueLength` /
  `summaryMaxTokens` (the overloads, and `agboss check`), no `compact` →
  `[compaction.missing-handler]`; a throw or no summary → `CompactionError`; `agboss describe`:
  `strategy: custom (GraphMemoryCompaction.compact())`, the class in `configHash`. A compaction summarises everything older than the
  **smallest** window among the agents and routers that use it, so no one loses a turn: a reader
  sees in full its window and every turn its compaction has not summarised yet, and only the
  summaries its turns do not cover. `summaryMaxTokens` is the summary call's `max_tokens` (counted
  by the model's server, `TokenLimit.MODEL_MAX` allowed, reasoning off): cut there → one "shorter" retry, then
  `CompactionError` (`compaction`: `compaction`, `summaryMaxTokens`; a failed call is one too, as its
  `cause`) — never a cut summary. A compaction runs lazily, before a new execution's first read of
  its thread (#120 S132), never after a turn: a finished turn's answer is always kept, a thread that
  ends pays for none, and a `CompactionError` fails the new execution before any of its work (no
  model call, no step, no turn kept). The compaction's model reads the turns through the application's
  and the workflow's PII policies (masked, S84 i); the summary is revealed before it is stored
  (`ExecutionRecordRepository`, by `(tenantId, threadId, compaction)`), and each reader's own
  policies mask it at its boundary. Spend `compaction:<name>` (category `compaction`);
  `result.compacted` lists what each compaction did before the execution; `[compaction.not-a-compaction]`,
  `[compaction.invalid-setting]`, `[compaction.decision-model]`,
  `[compaction.uncompacted-turns-invalid]` at assembly. Tests: `mockLlm(ConversationCompaction)
.thenReturn(replyWith("…"))` (`{ truncated: true }` = cut at the limit) — unscripted, a fixed
  summary. `@Agent({ memoryStrategy })` (`@agboss/core/memory`, `extends BaseMemoryStrategy`) replaces
  what one agent sees of that memory.

<!-- snippet-context
import { Agent, Compaction, CompactionStrategy, TurnLimit } from "@agboss/core";
-->

```ts
@Compaction({
  name: "conversation-compaction",
  description: "Summarises old turns of the conversation",
  prompt: "Summarise the turns under `Turns to compact`: what was asked, decided and is still open.",
  model: "moonshotai/kimi-k2.6",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 5,
  summaryQueueLength: 10,
  summaryMaxTokens: 400,
})
export class ConversationCompaction {}

@Compaction({
  name: "no-summaries-compaction",
  description: "No summaries: only the window of recent turns",
  strategy: CompactionStrategy.None,
})
export class NoSummariesCompaction {}

// @Workflow({ …, uncompactedTurns: 8, compaction: ConversationCompaction }) — its agents and routers
@Agent({
  name: "archive-agent",
  description: "Answers from the whole thread",
  prompt: "Answer from the thread.",
  model: "moonshotai/kimi-k2.6",
  uncompactedTurns: TurnLimit.ALL, // every turn in full: no summaries needed
  compaction: NoSummariesCompaction,
})
export class ArchiveAgent {}
```

- **Knowledge bases:** a `@Rag` class implementing `RagConnector`, bound per agent with
  `rag: [{ use, mode: RagMode.Tool | RagMode.Context }]`. **MCP:** `@McpServer`
  (`extends McpServerClient`) in `mcp: [...]`, its tools as `@McpTool` classes.
  **A2A (#387, #398 PR 3) — declared contracts:** a call to another application is an
  `@A2AAgent({ name: "-a2a-agent", url, target: { application, start }, input, output, price?, deps })`
  on a `…A2AAgent` class that `extends A2AClient<In, Out>` (`a2a/*.a2a-agent.ts`; `[name.kind-suffix]`,
  `[a2a.target-required]`), in `providers` — `execute(input)` is typed and validated both ways; what
  an application serves is an `@A2AExpose({ name: "-a2a-expose", version, exports: [Start] })`
  (`a2a/*.a2a-expose.ts`) listed in `@Application({ exposes })` with its `@McpExpose`s
  (`[application.expose-unknown-start]`, `[application.not-an-expose]`) and served by
  `a2aHttpListener(app, { expose, callerResolver })` (`[application.expose-unlisted]`; a request names
  its `start`, else `400 a2a.unknown-start` with several); `agboss describe --json` lists both sides
  under `application.contracts` (`exports`, `imports` with `usedBy`, each DTO's `schemaHash`, `schemas`);
  `agboss check --federation <snapshot…>` (#398 PR 4; files or folders of neighbours' `describe
--json`, no network; `checkFederation` in `@agboss/core/internal`) compares every consumed contract whose
  target is among them, structurally — `[federation.missing-target]`,
  `[federation.incompatible-schema]` with its blast radius (the consumer's workflows and tools),
  `[federation.snapshot-schema]`, `[federation.duplicate-application]`, and with the project's own
  earlier snapshot `[federation.version-not-bumped]` (a warning, an error under `--strict`).
- **PII policies (#120, S38):** a declarative `@PiiPolicy` — `name` (`-pii-policy`),
  `description`, `rules: [pii(kind or group, action)]`, `detectWithModel?`, `pseudonymKey?` — or a
  project's own detector — `@PiiPolicy({ name, action, deps })` + `implements PiiPolicyHandler`
  (`findMatches(text)` → `PiiMatch { start, end }`). Only the kinds a rule names are found (formats
  validated: Luhn, IBAN, Israeli ID, SSN rules; names and addresses by `detectWithModel`); a kind
  rule beats a group rule, the longest span wins. Actions: `replaceWithKind()` → `<israeli-id>`,
  `replacePart({ keepLast } | { pattern })` → `•••• 4242`, `replaceWithToken()` → `<email:7f3a91>`
  (HMAC-SHA256, the only reversible one), `blockWithRefusal({ refusal })` or `blockWithRefusal()`
  with `implements PiiRefusal` (`[pii.missing-refusal]` / `[pii.unused-refusal]`). Listed in
  `piiPolicies` of `@Application` → `@Workflow` → `@Agent` / `@Router` — lists add up,
  `excludePiiPolicies` removes one for that element (`[pii.exclude-not-inherited]`), two actions
  for one kind are `[pii.conflicting-rules]`. Masked and revealed **only at the model boundary**:
  everything a model reads is masked, its move revealed before any DTO is validated (a tool gets
  `alice@example.com`; an unknown token is an invalid answer); a block rule in what comes in or in
  an answer fails the execution (`PiiRefusedError`, `pii.refused`), in tool arguments or a result it
  rejects that call. Scope, checkpoint and every step's code hold real values; the token map is
  the state's `piiTokens` channel. Logs, traces, events and `result.record` are masked by the
  application's and the workflow's lists, whatever an element excludes. A `sensitive` action on a
  DTO or a context field (masking actions only) applies to that field.
  `@Application({ pseudonymKey: "piiPseudonymKey" })` names a `Secret` field of the environment:
  the HMAC key of sensitive fields, project detectors and policies without their own key — one
  token per value on every instance (a policy's own key wins); a policy that needs it when it is
  not set fails the start, naming the field (`testWith`: a fixed test key). Not set and not
  needed → a key of each root execution (#334: made at its start, kept in its checkpoint next to
  `piiTokens` and handed to its children — a resume, a failover or a recovery on another instance
  gives one value the same token; another execution gives it another) and the warning
  `[application.pii-instance-key]` (S94); logs and traces mask with a key of the instance.

<!-- snippet-context
import { Agent, PiiAction, PiiKind, PiiPolicy, pii, secret } from "@agboss/core";
-->

```ts
@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details from models",
  rules: [
    pii(PiiKind.Email, PiiAction.replaceWithToken()), // the model sees <email:7f3a91>, a tool the address
    pii(PiiKind.Phone, PiiAction.replacePart({ keepLast: 2 })),
  ],
  pseudonymKey: secret("PII_PSEUDONYM_KEY"),
})
export class ContactPiiPolicy {}

// @Application({ …, piiPolicies: [ContactPiiPolicy] }) — every agent and router of every workflow
@Agent({
  name: "order-agent",
  description: "Looks orders up",
  prompt: "Look the order up.",
  model: "moonshotai/kimi-k2.6",
  excludePiiPolicies: [ContactPiiPolicy], // its model sees contacts; logs and traces stay masked
})
export class OrderAgent {}
```

- **Guardrails (#120 PR 2)** block (safety); judges correct (quality). `@InputGuardrail` /
  `@OutputGuardrail({ name, description, prompt | promptUrls, model?, threshold, refusal?, deps? })`
  (`guardrails/*.guardrail.ts`, `-guardrail`): a yes / no question on a decision model (one
  `Decision.noul`) or a chat model (one answer tool), `model` else `defaults.guardrail.model`
  (`[guardrail.no-model]`), never the router's; P(yes) ≥ `threshold` fails the execution with
  `GuardrailBlockedError` (`guardrail.blocked`; `guard`, `refusal` — the text to send instead —,
  `key: guardrails.<name>.threshold`, `probability`, `threshold`). An input guardrail reads what an
  agent's or a model router's model reads of the visit — its input message, **masked** by that
  element's PII policies (S84 i) — before the model is called (an agent's in its loop's input node:
  a resume never checks again); an output guardrail reads an agent's answer (its text or its
  answer's JSON, masked) as it leaves the loop. A model that does not answer fails closed
  (`GuardFailedError`). The refusal is the decorator's text or the class's `refusal()` (`implements
GuardrailRefusal`, its services and the execution through `deps`) — never both
  (`[guardrail.refusal-twice]`), never neither (a compile error through the decorator's overloads,
  `[guardrail.missing-refusal]` at assembly); also `[guardrail.no-prompt]`,
  `[guardrail.threshold-invalid]`. Listed in `guardrails` of `@Application` → `@Workflow` →
  `@Agent` / `@Router` — lists add up, `excludeGuardrails` removes one for that element
  (`[guardrail.exclude-not-inherited]`, `[guardrail.not-a-guardrail]`); a model router takes the
  input ones (an `@OutputGuardrail` on a router is `[guardrail.output-on-router]`), a code router
  none (its own list: `[guardrail.no-model-call]`); a child workflow gets its own workflow's lists
  over the application's. Spend `guardrail:<name>` (category `guards`); events `onGuardrailStart`
  (`side`, `element`, `text`) / `onGuardrailEnd` (`isBlocked`, `probability`). Tests:
  `mockLlm(G).thenReturn(decideWith({ blocks: 0.9 }))` — unscripted, a guardrail passes. **Code
  guardrails (#383):** `decidedBy: DecidedBy.Code` (absent = `DecidedBy.Model`; options
  discriminated — `prompt` / `promptUrls` / `model` / `threshold` do not compile) decides by the
  class's `check(text)` (`implements GuardrailHandler`) on the same masked text, returning
  `GuardrailVerdict.passed()` / `.blocked()` (nominal: a plain object does not compile) — no model
  call, cost 0, the same refusal (text or `refusal()`), `GuardrailBlockedError` (`probability` 1,
  `threshold` 1), levels, `excludeGuardrails` and events (a pass `probability` 0); a `check` that
  throws or returns no verdict fails closed (`GuardFailedError`, its error the `cause`);
  `[guardrail.missing-handler]` without `check`; `agboss describe` prints `decidedBy: code`;
  `testGuardrail(G)` takes no `model`.

<!-- snippet-context
import { ExecutionContext, InputGuardrail, Injectable, OutputGuardrail, type GuardrailRefusal } from "@agboss/core";
import { OneOf } from "@agboss/core/dto";
export class ClinicExecutionContext extends ExecutionContext {
  @OneOf({ values: ["en", "he"] })
  locale!: "en" | "he";
}
@Injectable()
export class RefusalTextService {
  legalAdvice(locale: "en" | "he"): Promise<string> {
    return Promise.resolve(locale === "he" ? "אין ייעוץ משפטי." : "No legal advice.");
  }
}
-->

```ts
@InputGuardrail({
  name: "legal-advice-guardrail",
  description: "Blocks requests for legal advice",
  prompt: "Does the message ask for legal advice?",
  model: "typesafe/jev-1.13",
  threshold: 0.8,
  deps: [ClinicExecutionContext, RefusalTextService], // the refusal in the sender's language
})
export class LegalAdviceGuardrail implements GuardrailRefusal {
  constructor(
    private readonly clinicExecutionContext: ClinicExecutionContext,
    private readonly refusalTextService: RefusalTextService,
  ) {}

  refusal(): Promise<string> {
    return this.refusalTextService.legalAdvice(this.clinicExecutionContext.locale);
  }
}

@OutputGuardrail({
  name: "no-legal-advice-guardrail",
  description: "Blocks answers that give legal advice",
  prompt: "Does the answer give legal advice?",
  threshold: 0.8, // no model: defaults.guardrail.model
  refusal: "I can't give legal advice. Please contact a lawyer.",
})
export class NoLegalAdviceGuardrail {}

// @Application({ …, guardrails: [NoLegalAdviceGuardrail] }) — every agent of every workflow;
// @Agent({ …, guardrails: [LegalAdviceGuardrail] }) — this agent's model only
```

### Environments

One set per application, in `environments/` next to the application file (#261). The contract is a
plain class with declared fields only, declared once — `@Application({ environment: AppEnvironment })`
above, required (no settings → `environment: EmptyEnvironment`, no environment file needed); a
value in it fails assembly (`[environment.contract-value]`), a field a listed framework
implementation reads and the contract lacks too (`[environment.missing-field]`):

```ts file=src/desk/environments/app.environment.ts
// environments/app.environment.ts — the contract (a secret is a `Secret` field: README → Environments)
export class AppEnvironment {
  auditUrl!: string;
  retries!: number;
}
```

Each environment is a plain object typed by it (a missing field does not compile), in
`<name>.environment.ts` — the file name is the environment's: `env("X")` (`env.integer`, `env.flag`,
`{ default }`; `env.optional("X")` — unset is `undefined`, for an optional field) reads a process variable at start, `secret("X")` a `Secret` (no default, a literal
does not compile). Tests run on `test` — no `test.environment.ts` fails the test, so it never reaches
dev's addresses:

```ts file=src/desk/environments/dev.environment.ts
import { env } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: env("AUDIT_URL", { default: "http://localhost:4000" }),
  retries: env.integer("AUDIT_RETRIES", { default: 3 }),
};
```

```ts file=src/desk/environments/test.environment.ts
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { auditUrl: "http://audit.test", retries: 0 };
```

Components read it as `applicationContext.environment` (`deps: [ApplicationContext]`, #261 PR 3 —
there is no separate token), typed by the contract through `.agboss/types.d.ts`, never
`process.env`; the chosen environment's name is `applicationContext.environmentName`. A `Secret`
prints as `***` everywhere and only `.reveal()` gives the value:

```ts file=src/desk/services/audit.service.ts
import { ApplicationContext, Injectable } from "@agboss/core";

@Injectable({ deps: [ApplicationContext] })
export class AuditService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  eventsUrl(): string {
    return `${this.applicationContext.environment.auditUrl}/events`;
  }
}
```

`--env <name>` / `createApp(App, { env })` / `testWith(App, { env })` pick one (default `dev`, tests
`test`); a missing variable fails the start naming it, the field and the environment, never the value
(`DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`); `agboss check --env <name>` lists the
variables it needs, by name, marked value / secret, never a value. Dev / prod parity: the same `providers` in every
environment, only values differ. Model provider keys are `Secret` fields of it too (#266): a
`@ModelProvider`'s `apiKey` names the field (`"openRouterApiKey"`), a test environment may leave it
out (models are scripted); `agboss check` reads only the contract's shape (its secrets with
`--models`), so `npm run types` needs no key. A base URL is a text field the same way (`baseUrlField`;
`env.optional("OPENROUTER_BASE_URL")`, no default: unset → the provider's `baseUrl`). README →
Environments has more.

### Judges and decision models

`@Agent({ judges: [AnswerGroundedJudge], maxRetries: 1 })` runs each `@Judge({ name, model, reply,
deps })` (`implements JudgeHandler<TReply>`) on the agent's answer **as its DTO** (#262 S115):
`judge({ variant, reply, task, attempt }: JudgeInput<TReply>)` gets the validated answer object —
`reply` is a DTO class, `oneOf(A, B)` (`A | B`), `listOf(XDto)` (`readonly XDto[]`),
`listOf(oneOf(A, B))` (`readonly VariantOf<A | B>[]`, each item `{ variant, value }`) or
`PlainTextDto` for a text agent (`{ text }`) — the shapes of `output`. `variant` (#262 S125) is the
class the answer validated as, from the answer tool the agent used (never guessed from its shape):
`JudgeInput<A | B>` is a discriminated union on it, narrowed by `isVariant(input, A)` (an item by
`isVariant(item, A)`); a single DTO, `listOf(XDto)` or `PlainTextDto` judge has that one class; a
`listOf(oneOf(…))` judge has none of its own, only its items'. an agent whose `output` its judge does not judge (a
text agent with a DTO judge, a `oneOf` variant it does not cover, a list agent with a judge of one
value or the other way round) fails assembly with `[judge.wrong-reply]`. Verdicts are built only with
`JudgeVerdict.passed({ metrics? })` / `JudgeVerdict.failed({ reason, metrics? })`; a failed one's
`reason` goes back to the agent for its retry, and when retries are spent the run throws
`QualityGateError` (`rejections: [{ judge, reason }]`). `testJudge(Judge, …)({ variant, reply,
task, attempt })` takes `reply` as a plain object, typed by the judge (a `variant` with another
class's value does not compile). A judge's own model is a chat
model (`judgeModel.invoke`, `deps: [JudgeModel]`) or a **decision model**
(`judgeModel.decide({ state, questions })` with
`Decision.noul` / `Decision.choice` / `Decision.score`, answers typed by the questions; `DECISION_MODELS`
served by `DecisionsModelProvider`). The wrong call for the model's kind throws `ModelKindError`.
Routers and guardrails use decision models too. README → Quality gates has a full judge. **Code
judges (#396):** `@Judge({ decidedBy: DecidedBy.Code })` (absent = `DecidedBy.Model`; options
discriminated — a model judge requires `model` (`[judge.no-model]`), on a code judge it does not
compile) decides by its `judge(input)` alone — no model call, cost 0, its services and the
execution through `deps`; a `model` or an injected `JudgeModel` is `[judge.model-on-code-judge]` at
assembly (a `JudgeModel` reached through a service throws it when called); it works in an agent's
quality gate beside model judges, `mockLlm(CodeJudge)` names why it has no script, `testJudge(J)`
takes no `model` (one is a `TestSetupError`). A model judge whose model has its judged agent's vendor prefix (`openai` of
`openai/gpt-6`; a suite's judge: any agent of its start's workflow) warns `[judge.same-model-family]`
(an error under `--strict`, #396 PR 5). **Eval suites (#396 PR 1, `@agboss/core/eval`):**
`@EvalSuite({ name: "-eval-suite", description, start, checks, cascade, cases })` — `checks` in
order (`checkTrajectory()`, `judgedBy(Judge)`), `cascade: EvalCascade.StopAtFirstFailure | RunAll`
required (skipped checks are `CheckStatus.Skipped`); `evalCase({ name, tenant?, execution?, history?:
[pastTurn(Start, input, Finish, output)], turns: [turn(input)], tools?: { required: [toolCall(Tool,
partial)], forbidden: [Tool], invariants: [toolInvariant(Tool, (input) => …)] }, judges?, variants? })`,
typed by the start's input, the application's contexts and each tool's input. Assembled on its
application by `checkEvalSuite` (`@agboss/core/internal`; run by `runEvalSuite`, PR 2 — `agboss eval run`):
`[name.kind-suffix]`
(name and class), `[eval.unknown-start]`, `[eval.duplicate-case]`, `[eval.judge-wrong-reply]` (an
eval judge judges a finish output its start reaches, one value), then `EvalCaseInvalidError`
(`eval.case-invalid`: tenant / execution, turns, variants and history validated, every issue, no
value). At run time (#396 PR 2, `src/eval/run/`) `checkTrajectory()` reads the last turn's
`result.toolCalls` (a required tool: a call it ran with the partial's arguments; a forbidden one: any
call; an invariant: every call with checked arguments), and a judge runs in the frame of the case's last
execution, created by the application's container, on the finish's output as its DTO — a run ending at
a finish it does not judge fails that check; a model judge no agent lists is bound through the
application's models, counted in its application budgets. A run passes when every check that ran
passed (a skipped one fails it, S2 Q6).

### Runs: context, limits, errors

- `const app = await createApp(DeskApplication, { env })` (#261: always an `@Application`;
  `createApp(Workflow)` does not compile). `app.execute(Start, input, { threadId, ownerId, signal,
tenant, execution, onStream, deadline })` (`deadline`, #398: `DeadlineExceededError`, `limit.deadline`,
  before the next step or model call) runs the workflow of that start (any workflow of the
  application; one start in two workflows → `[application.ambiguous-start]`) → `ExecutionOutput`
  (`output` is the finish's DTO, `finish`, `path`, `spend`, `threadId`, `tenantId`, `executionId`);
  `app.resume({ pauseId, decision }, { tenantId, ownerId | answeredBy })` answers one pause (#267) —
  by its id, never by thread, found by `(tenantId, pauseId)` anywhere in the tree (unknown or another
  tenant's → `UnknownPauseError`); `result.pending: PendingPause[]` lists every waiting pause
  (parallel branches each pause on their own; the execution rests when nothing else can move) and
  an execution with others left pauses again with the rest. Who answers is the role's `answeredBy`:
  `ThreadOwner` — `ownerId`, the id listed in `result.pending`; `Channel` — `answeredBy` (non-empty,
  recorded on the pause and in `onExecutionResume`), the id only in the channel's `ask.pauseId`; the
  other credential → `PauseAnswererError`. The decision (`ToolCallApprovalDecisionDto`: `approved`,
  `reason?`, `overrideArguments?` only with `approved: true`) is validated before it is recorded.
  Each pause is a record (`PausedExecutionRepository`, S35) made by its step's idempotency key
  before `send`: `Pending` → `Resolved` (an answer) → `Taken` (its step went on), or `Cancelled`
  (withdrawn: a `FailFast` sibling failed, the thread was cancelled, the tree ended) — an answer to
  any but `Pending` → `NotPausedError`. `app.resume({ pauseId, reply }, …)` answers with free text
  instead (exactly one of `decision` / a non-empty `reply`, else `DtoValidationError`), read by the
  role's `@ReplyInterpreter` (Components above). Who answered each pause is in
  `result.record.pauses` (`{ record: true }`, #267 S107): every resolved pause of the tree in the order
  asked — `PauseAnswerRecord { pauseId (none for a Channel pause), executionId, step, role,
answeredBy, responder, resolution: PauseResolution.Decided | Replied | Withdrawn | Cancelled,
askedAt, resolvedAt, decision }`, the decision PII-masked, none when withdrawn or cancelled; each
  child's own in its `ChildExecutionRecord.pauses` (#267 S124) — written when the pause is
  resolved into the execution records (`ExecutionRecordRepository.savePauseAnswer` /
  `findPauseAnswersByTenantIdAndRootExecutionId`), the permanent history; the pause records are
  operational state, never read for it. A resolved pause record (`Taken`,
  `Cancelled`) is kept `@Application({ pauseRecordRetention })` (default `hours(24)`), then removed by
  the recovery sweep (`PausedExecutionRepository.deleteResolvedBefore(cutoff)`, on the `Clock`): a
  late answer is `NotPausedError` within it, `UnknownPauseError` after; `Pending` is never removed. `app.cancel(threadId, { tenantId, ownerId })` aborts a
  running execution (`ExecutionCancelledError`) or drops a paused one (its pauses withdrawn). The options are named like the
  `ExecutionContext` fields they fill — `threadId`, never `thread`. A thread with an `ownerId`
  rejects another owner (`ThreadOwnerError`).
- **Context levels (#261 PR 3):** `ApplicationContext` (`name`, `version`, `instanceId`,
  `startedAt`, `environmentName`, `environment`, `host`) → `TenantContext` (`tenantId`, `weight` —
  a positive integer, default 1, for #266's `TenantWeighted` — and the project's fields) →
  `ExecutionContext` (`executionContext.tenant`, `.tenant.application` — the same objects).
  Each is its type and its DI token; a component takes the one of its level. The project extends a
  level by subclassing with DTO field decorators (no `prompt`: `[context.prompt-unused]`) and
  declares it once, `@Application({ tenantContext, executionContext })`; the values come per
  execution, `tenant: { … }` / `execution: { … }` — `ContextValues<T>`, typed per start by the
  generated types, validated before the first step (invalid → `dto.invalid`, `onExecutionRejected`, the
  field named, never the value), frozen, kept in the checkpoint (a resume runs on them). Nothing
  declared → `tenant: { tenantId }` optional (`"default"`), `execution` does not compile. A
  thread's key is `tenantId` + `threadId`: another tenant's thread does not exist for the caller —
  `execute` with an id the tenant does not have yet creates the caller's own thread (#262 Q4: an
  idempotent id; bound to `ownerId`; only once the budgets pass; a key's text — the business key's
  rules, #538 —, else `InvalidThreadIdError` naming its `rule`, never the id, and kept out of
  `onExecutionRejected`; `cancel`'s thread id the same, #552), `cancel` of it is `UnknownThreadError`;
  a tenant id is a key's text too (#552: at `execute`, `resume` and `cancel`, else `dto.invalid` naming
  `tenantId` and the rule, never the id — `t\uD800` and `t\uD801` would be one tenant in UTF-8); every
  record, lease and tree key carries `tenantId`, traces too (LangGraph `metadata` / `tags`,
  Langfuse `tenant:<id>`). Identity only — never secrets (a service gets a secret from the
  identity). Injecting a subclass the application does not declare → `[context.not-declared]`.

<!-- snippet-context
import { ExecutionContext, Injectable, PiiAction, TenantContext } from "@agboss/core";
import { OneOf, Text } from "@agboss/core/dto";
-->

```ts
export class ShopTenantContext extends TenantContext {
  @OneOf({ values: ["free", "pro"] })
  plan!: "free" | "pro";
}

export class ShopExecutionContext extends ExecutionContext {
  @Text({ sensitive: PiiAction.replaceWithToken() }) // identity, masked for models, logs, traces (#120)
  userId!: string;
}

// @Application({ …, tenantContext: ShopTenantContext, executionContext: ShopExecutionContext })
// app.execute(SupportWorkflowStart, message, {
//   threadId, ownerId: userId, tenant: { tenantId, plan }, execution: { userId } });

@Injectable({ deps: [ShopTenantContext] }) // inside an execution: its tenant; outside → context.unavailable
export class PlanService {
  constructor(private readonly shopTenantContext: ShopTenantContext) {}

  isPro(): boolean {
    return this.shopTenantContext.plan === "pro";
  }
}
```

- **The execution lease (#265, Q58):** `execute` / `resume` move a tree only while holding its lease
  (keyed by `tenantId` and `rootExecutionId`, `seconds(30)`, renewed every 10 s and before
  every checkpoint write, released when the pass ends; live while `expiresAt > now` and only then,
  for its holder too — at `now >= expiresAt` its `renew`, `yield`, `reclaim`, `confirmNow()` and
  fenced writes are refused, taken or not, and the holder takes the tree again only by `acquire`, a
  takeover from itself, #534). A `resume` records its decision first —
  the pause goes `Pending → Resolved` atomically, a second resume of one pause gets
  `NotPausedError` — then waits for the lease; the holder continues with one `Command({ resume })`
  mapping LangGraph's interrupt id of every answered pause, takes the decisions resolved meanwhile
  before the tree rests (the drain), and the waiting call returns the tree's current output. A holder that lost the lease stops: its call
  rejects with `ExecutionLeaseLostError` (`execution.lease-lost`) — no `.onError`, no `onExecutionError`, no
  failed record. Fencing is local too (#335): the holder trusts its lease until `sentAt + remaining
− LEASE_SAFETY_MARGIN` (1 s) of its last confirmed acquire or renewal (#533: `remaining` the time
  the store says is left — `ExecutionLease.remaining`, `renew`'s answer, `undefined` once over —,
  `sentAt` when it sent the request, counted on its `Clock.monotonicNow()` and on its wall clock
  — the earlier ends it, so an offset moves neither and the wall clock only ever ends it sooner; the
  store decides expiry by its own time, `StoreClock` — a networked store's database clock in each
  statement, the host's for in-memory and SQLite, the test's clock in `testWith` and the contract
  suites; the margin covers ρ_holder + ρ_store ≤ 1 s / 30 s) — a lease store error before then lets
  a checkpoint write go on, at that moment the execution's `signal` aborts with
  `ExecutionLeaseLostError`, so an agent's tool loop starts no further model or tool call; an
  outbound call's `send` starts only while it holds (`assertHeld()` right before). Tests skew an
  instance with `testWith(App, { instances: 2, clockSkews: [ClockSkew.none, ClockSkew.ahead(…)] })`
  (`ClockSkew`, `SkewedClock`: wall time, monotonic time and sleeps; the stores keep the test's clock).
  While a parent node waits for `AnyInstance` children it yields the lease only when no other step
  of the tree runs (#471: a running sibling keeps it, a step starting meanwhile takes it back first)
  — in the store (#516, `yield` / `reclaim`): still its holder's, renewed on, so every instance sees
  the waiting tree held, a dead holder's lease expires and normal recovery takes the tree over, and a
  reclaim that finds it taken stops the holder (`ExecutionLeaseLostError`, "expired while it waited
  for remote children").
  A take of an expired lease names its holder (`ExecutionLease.takenOverFrom`, #501, optional for an
  external store); a takeover — that, or any take of the recovery sweep, an undo's takeover, a remote
  child's reclaim or a re-acquire after a yield (`LeaseTakeoverReason`) — is a `Takeover` row of the
  lease log and an `onExecutionLeaseTakeover`; a lease released and taken again is none. A take of
  work already over is none either (#520, `LeaseTake.isOver`): a remote child's claim whose queue row
  is no longer that claim, a sweep's take of a root whose record no longer runs — looked at before
  the store is asked and again once it gave the lease, which then goes back at once.
  Wiki → Several-instances.
- **Fencing external writes (#471):** `executionContext.fence` is the lease the current step runs
  under — the root's for a root, its `ParentInstance` children and `ThisWorkflow` levels, an
  `AnyInstance` child's own: `scopeKey` (each part `encodeURIComponent`-encoded, joined by one
  `:`), `tenantId`, `leaseExecutionId`, `token` (the lease's `leaseEpoch`, a counter of that one
  key), `confirmedUntil`, `assertHeld()` (local; past `confirmedUntil` it expires the lease first),
  `confirmNow()` (a renewal now: confirmed → the #360 checks; anything else aborts the lease and
  rejects) and `fenced(observedToken)`. An external system keeps the highest token per `scopeKey`
  with the step's `idempotencyKey` in one transaction — `incoming >= highest` accepted, below
  refused with `ExecutionFencedError` (`execution.lease-lost.fenced`, `extends
ExecutionLeaseLostError`: `scopeKey`, `tenantId`, `leaseExecutionId`, `token`, `observedToken`),
  found anywhere in a cause chain or an `AggregateError` and a hand-over at every site — no
  `.onError`, no undo, no `onToolEnd`, nothing to the model, the record stays `running`, no
  `onExecutionError`; the moving call rejects with the fenced error itself (`fencedErrorOf` before
  the signal's reason) — and a `HandedOver` row of the lease log with `onStepHandedOver` (#501): a
  zombie refused at a write leaves one, a zombie that never wrote again none. Exactly-once only when
  the external system checks both atomically; a mark
  keyed by a shared aggregate fences parallel `AnyInstance` children wrongly. Frames with no lease
  (a reply interpreter, `maxSpend()`, an eval judge, an MCP-exported tool, a slice) and an
  ancestor's `parent.fence` / `root.fence` throw `ExecutionContextUnavailableError`. Wiki →
  Several-instances.
- **The fenced effect (#500):** `FencedEffectRepository<TTransaction>` (infrastructure, the
  built-in `InMemoryFencedEffectRepository`; `SqliteFencedEffectRepository` listed with
  `SqliteExecutionLeaseRepository` — #526: a listed fenced-effect or outbound-call store and the
  application's lease store declare one `static backend` (`"in-memory"`, `"sqlite"`, `"postgres"`,
  `"<kind>:<database>"`), else `[application.store-backend-mismatch]` (#539: its hint names a lease store on
  the fencing store's backend, the core's when it has one) / `[application.store-backend-undeclared]`; two listed
  stores of one fencing contract, or two lease stores, are `[di.ambiguous-implementation]` at assembly (#539);
  the explicit opt-out `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection` is not checked and
  warns `[application.lease-check-not-atomic]`; rate limits, the queue and the lease log are on any
  backend; `static leaseRepository` names the lease store a unit runner holds its lease in; the
  unlisted default beside SQLite leases fails its first call, `FencedEffectStoreMismatchError`) makes one protected write exactly once per step:
  `saveResultIfAbsent(fencedEffectKeyOf(executionContext, name), work)` → `FencedEffectOutcome {
status: FencedEffectStatus.Ran | Replayed | Joined, result, token }`, in one transaction — the
  key's lease (not its epoch, released, expired → `ExecutionFencedError`, a hand-over), the scope's
  high-water mark (a lower token refused before any key is read), the key (written → the stored
  result, `work` not run), then `work(transaction)` and its result (`JsonResult<T>`, JSON within
  `@Application({ fencedEffects: { maxResultSize } })`, default `kilobytes(64)`, else
  `FencedEffectResultTooLargeError`); a throw rolls everything back; concurrent calls on one key of
  one instance share the first's outcome (`Joined`), two instances serialize (`Replayed`). On SQLite
  `work` gets the connection's `DatabaseSync` and must be synchronous (a promise →
  `FencedEffectAsyncWorkError`, rolled back). Results and marks are removed by the recovery sweep
  after `fencedEffects.retention` (default `hours(24)`, above the lease: `[application.fenced-effects-invalid]`).
  Inject the listed store's own class for a typed transaction; unit runners hold their lease in the
  store's lease store. `fencedEffectContract` (`@agboss/core/testing/contracts`) for a store of your own;
  its key's rules are exported (#526 AC5): `checkedEffectName`, `replayedFromOf` (a row's `null`s
  taken, a stored step checked), `storedKeyFactsOf`, `fencedKeyIdentityOf`, `pendingOutboundCallOf`.
  A store's connection (`SqliteConnection`, `PostgresConnection`) need not be listed (#526 AC8): the
  workflow graph check takes an unlisted class under an infrastructure implementation as its own
  registration, as the container creates it.
- **Calls that leave the system (#505):** `OutboundCalls` (a core service, `deps: [ExecutionContext,
OutboundCalls]`) — `send(fencedEffectKeyOf(executionContext, name), { target, operation, request,
send, reconcile })` records an intent before the call and settles it after, over the infrastructure
  contract `OutboundCallRepository` (`InMemoryOutboundCallRepository`; `SqliteOutboundCallRepository`
  listed with `SqliteExecutionLeaseRepository`, else `[application.store-backend-mismatch]`; every
  read and write of an intent fenced like a fenced effect — a zombie can neither record nor send):
  none → recorded `Pending`, `fence.confirmNow()`, `send(call)` with `call.idempotencyKey` (the step's
  key and the name) → `Completed` (`Sent`); `Completed` → its stored result (`Replayed`); `Pending` →
  `reconcile(lookup)` → `OutboundCallReconciliation.completed(result)` (`Reconciled`) / `.notSent()`
  (sent once more, the same key, attempt + 1) / `.unknown({ reason })` →
  `OutboundCallUnreconciledError` (`outbound-call.unreconciled`, a `StepFailedError`, the intent kept
  pending; also a `reconcile` that throws or gives no verdict); `Failed` → sent again. Every attempt
  has an owner (`attemptOwner`, a random id per claim); a new attempt is a compare-and-set on status,
  attempt and owner (`markPending(key, expected, claim)`, `OutboundCallState`, `OutboundCallClaim`):
  the loser sends nothing and reads again; `markCompleted` / `markFailed` end an attempt only for its owner (a compare-and-set), the owner live from before its intent is recorded, nothing sent once the step aborted — the winner's result replayed, its pending attempt
  `OutboundCallInFlightError` (`outbound-call.in-flight`), at most three reads; the same call this
  instance is making meanwhile is joined (`Joined`), never reconciled or resent. Masked **when
  written** by the calling frame's mask (the application's and that workflow's PII policies; a
  child's own): the request, the result and a failure's text — every read shows what is stored; `send`
  and the step get real values, a replay the masked result, `reconcile` the stored request
  (`lookup.storedRequest`) and the key to look the call up by; no mask where policies exist →
  `OutboundCallUnmaskedError`. `@Application({ outboundCalls: { maxPayloadSize, retention } })`
  (64 KB, `hours(168)`; `OutboundCallPayloadTooLargeError`; ended intents removed by the sweep,
  pending ones never). Read by `app.outboundCallsOf({ tenantId, rootExecutionId })` /
  `app.pendingOutboundCalls({ tenantId })`, `ExecutionHistoryRecord.outboundCalls`, each move an
  `OutboundCall` row of the lease log and an `onOutboundCall` (`OutboundCallEventOutcome`: `Recorded`,
  `Sent`, `Replayed`, `Reconciled`, `NotSent`, `Unknown`, `Failed`, `Joined`; never a payload);
  `outboundCallContract` for a store of your own. flow-patterns' travel desk books its flight with it.
- **Business idempotency keys (#508):** `fencedEffectKeyOf(executionContext, name, { businessKey,
fingerprint? })` keys an effect or a call by a business identity (`"order:42"`; a key's text,
  #538 — 1–200 characters, no C0 / C1 control (`Cc`), no format character (`Cf`: zero-width, bidi
  controls, U+FEFF, …), no lone surrogate, no space but U+0020 and that one single and inside (#547: `Zs`, U+2028, U+2029 refused, `space-separator`; none at an edge, never two in a row, `spacing`), in NFC, never normalized silently: `keyTextRuleOf(text)`
  → `KeyTextRule`, the same for thread ids; else `InvalidBusinessKeyError`,
  `fenced-effect.invalid-business-key`, its `rule` named, never the key — checked by
  `fencedEffectKeyOf`, `OutboundCalls.send` and every store's entry, `checkedBusinessKey` for a
  store of your own) —
  one row per tenant, name and business key, whatever step, execution or thread makes it; fencing
  is unchanged (the caller's lease and scope mark first, so a zombie is refused before any lookup).
  The same key and fingerprint (an HMAC of canonical JSON under a subkey of the application's `pseudonymKey`, `"agboss/fingerprint/v1"` — a labelled SHA-256 without one; `OutboundCalls` takes its request's) →
  `Replayed` with the first result and `replayedFrom` (`FencedEffectOrigin`: the execution, node and
  visit that made it); another fingerprint → `IdempotencyKeyConflictError` (`fenced-effect.key-conflict`:
  `effect`, `businessKeyHash?` — a handle, HMAC-SHA256 of `business-key\0<key>` under a subkey of the execution's PII key (`HMAC(piiKey, "agboss/business-key-handle/v1")`: every other use of the PII key than its tokens derives a subkey of its own), none without one; never the key), nothing run or sent, also for a concurrent call of
  this instance (never joined). A pending call is in flight while its attempt's owner lives — sending in
  this instance, whatever the key (joined, `Joined`; a joiner shares only a success or the other
  system's own error, whatever was thrown, else makes its own call), or, under a business key, under
  a lease still live on another instance (`OutboundCallRepository.leaseStateOf(lease)` →
  `OutboundCallLeaseState.Live`; `Ended` once released or its token moved on; an expired one is
  closed by the check itself in one atomic step, `Superseded` — released at the token it was held
  at — marked as closed by a check, so the next take is a takeover from that holder and token —, so
  its holder can neither renew, yield, reclaim nor write under it again; a late renewal and the check never both win —,
  the close an `OutboundCall` row `LeaseSuperseded` with `supersededLease` and a warning
  `outbound-call.lease-superseded`; a holder releases its lease only once its attempts settled and
  never yields it under one, both bounded by `@Application({ outboundCalls: { attemptTimeout } })`
  (default `minutes(2)`, from the attempt's start) and its instance's stop: past it, it stops
  renewing without releasing, so the call is in flight for `attemptTimeout` plus up to the lease's
  30 s; a send still hung past this bound can coincide with a reconcile and a resend; the provider must deduplicate on `call.idempotencyKey` (G1)) → `OutboundCallInFlightError`; once its owner is gone, the next
  caller reconciles it, by the compare-and-set. An answer that comes after its lease was handed over is fenced, not stored,
  and logged (`outbound-call.answered-after-hand-over`). An attempt answered after a newer one took
  the intent over is `Superseded` (both reached the other system; an error `outbound-call.superseded`
  on the instance's log, the newer attempt named — "unknown" when the intent cannot be read). An
  answered call ends `Completed` even when its result cannot be stored (a marker in its place, a
  warning `outbound-call.result-not-stored`, never `Failed`, which would resend); a replay of it is
  `OutboundCallResultNotStoredError` (`outbound-call.result-not-stored`, a `StepFailedError`,
  nothing sent). A fingerprint is kept in the store's row only — no read, record, export or event
  shows it; rotating `pseudonymKey` changes every fingerprint, so an intent recorded before is a
  conflict for the same request after. Effect names are 1–100 of `[A-Za-z0-9._-]`
  (`InvalidFencedEffectNameError`, checked again at every store method for a key built by hand); the key sent with the call is `<tenant>:<businessKey>:<name>`,
  each part `encodeURIComponent`-encoded; operator reads, kept records and errors name a business
  key by its handle only (`business-key:<handle>:<name>`), and so does `OutboundCallOutcome.idempotencyKey`. SQLite: `fenced_effect_business_results` and the
  `outbound_calls` partial unique index on `(tenant_id, name, business_key)`. flow-patterns' credit
  desk charges under `credit:<applicationId>`. Tests: `callTools(callTool(A, …), callTool(B, …))` —
  one move calling several tools at once (each its own task under `TestConcurrency.Real`).
- **Recovery and the graceful stop (#265 S30 / S51):** a root's record is
  `ExecutionRecordStatus.Running` while its tree moves. Every instance looks for `running` roots at
  start and every 30 s (`ExecutionRecordRepository.findByStatus`), takes the lease of one whose
  holder died or stopped and continues it from its last checkpoint (a resolved pause first) — only
  the interrupted step runs again; another config's root is left to a compatible instance (logged
  once). Observers: `onExecutionResume` with `reason: ResumeReason.Recovered` (`Answered` for
  `app.resume`). `app.close()` stops the sweep, `onStop`, waits up to the shutdown timeout
  (`@Application({ shutdownTimeout })`, `app.close({ timeout })`, default `seconds(25)`), then
  interrupts what is left: its call rejects with `ApplicationStoppingError`, no `onExecutionError`, the lease
  released at once, the record stays `running`. `createApp` closes on SIGTERM / SIGINT (listeners
  removed when `close()` finishes); `testWith` never listens.
- **Health checks (#300):** `app.checkLiveness()` / `app.checkReadiness()` → `HealthReport { status,
components }` (the worst component's `HealthStatus.Healthy | Degraded | Unhealthy`; each
  `HealthComponentReport { name, kind: HealthComponentKind.Application | RecoveryLoop | Store |
ModelProvider | Project | StepSlots, status, reason?, duration }`) — the project's server exposes them, no
  endpoint of the framework. Liveness: no I/O — the application (`Unhealthy`, `stopping`, from
  `app.close()` on) and the recovery loop (`Unhealthy` when its last sweep ended more than three
  sweep intervals ago on the `Clock`). Readiness: liveness's components, every store's `ping()`
  (the #265 contracts, the checkpoint saver — one without `ping()` is read for a thread that does not
  exist), every model provider's circuit breaker from `RateLimitRepository` (open → `Degraded`, never
  a model call), the instance's step slots when `maxConcurrentSteps` is set (`Degraded` while none
  is free, #332) and every `@HealthCheck` of `@Application({ healthChecks })` — at once, each under
  its timeout (stores and providers `seconds(2)`) on the `Clock`. A check that throws or times out
  is that component's `Unhealthy` (`reason`: the error's message, `timed out after 2 s`); neither
  call rejects. `@HealthCheck({ name, timeout, deps? })` (`-health-check`, `[name.kind-suffix]`;
  `[health.not-a-health-check]`, `[health.duplicate-name]`) + `implements HealthCheckHandler`,
  created by the container; `check()` returns `HealthCheckResult.healthy()` / `.degraded({ reason
})` / `.unhealthy({ reason })` (branded: a plain object does not compile). The probes load on first
  use (`src/health/application-health.ts`); `testWith`'s `app` has both, also during and after
  `close()`.

<!-- snippet-context
import { HealthCheck, HealthCheckResult, Injectable, type App, type HealthCheckHandler, type HealthReport } from "@agboss/core";
import { seconds } from "@agboss/core/units";
@Injectable()
export class CrmClient {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
declare const app: App;
-->

```ts
@HealthCheck({ name: "crm-health-check", timeout: seconds(2), deps: [CrmClient] })
export class CrmHealthCheck implements HealthCheckHandler {
  constructor(private readonly crmClient: CrmClient) {}

  async check(): Promise<HealthCheckResult> {
    const isReachable: boolean = await this.crmClient.ping();
    return isReachable
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "CRM is unreachable" });
  }
}

// listed in the application: healthChecks: [CrmHealthCheck]
const liveness: HealthReport = await app.checkLiveness();
const readiness: HealthReport = await app.checkReadiness();
```

- **`ExecutionContext` (#280)** is the one context of an execution, injected through the
  constructor (`deps: [ExecutionContext]`, a parameter named `executionContext`) into any component;
  there is no `ctx` parameter (tools, actions, judges get only their input). Read-only data:
  `executionId`, `threadId`, `ownerId`, `tenant`, `signal`, `workflow` (`type`, `name`, `version`,
  `startedVersion`, `configHash`), `step` (`component`, `nodeId`, `visitNumber`, `idempotencyKey` =
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, `callId` during a tool
  call, `itemIndex`, `copyNumber`), the tree (#263: `parent`, `root`, `depth`, `itemIndex` — a
  per-item child's index —, `executionOf(W)`, the nearest execution of `W` from this one up). Every read gives the current step (an `AsyncLocalStorage` frame per node visit and per
  tool call, closed when it ends); outside an execution or after its step ended a read throws
  `ExecutionContextUnavailableError` (`context.unavailable`). No input, no metadata in it: domain
  data come through `input`. Units: a unit runner (`testTool`, `testAction`, …, Testing below)
  runs the component in its step's frame; a class created by hand takes `testExecutionContext()` —
  with `{ tenantContext, tenant, executionContext, execution, application: { environment } }` for
  the levels. Framework code reads the
  run with the internal `extractRunContext` — never by parsing `configurable`.
- **Spend of services that are not models** (#280 S43): `deps: [SpendRecorder]` in a `@Tool` /
  `@Action`, `this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) })` — into the
  current tool call's or step's spend (`tool:<name>` / `action:<name>`), counted in the
  execution's budgets; outside a frame `[spend.outside-step]`. In a tool call `executionContext.signal` is the
  call's: the execution's signal and the tool's `timeout` timer (S45).
- **Limits:** `@Workflow({ maxSteps })` — visits of agents and routers in one execution (default:
  (agents + routers) × 3), checked at assembly: `[limits.max-steps-too-low]` (no finish fits in a
  hand-set `maxSteps`, or the default cannot hold the worst case of a per-item launch — set
  `maxSteps`), `[limits.branch-exceeds-max-steps]`, `[limits.max-steps-unused]`; a node's
  `maxVisits`. **Money is `@Budget` components** (#261), all in `@Application({ budgets })`
  (`config/budget.config.ts`): `@Budget({ name, scope, period?, workflow?, deps? })` +
  `implements BudgetHandler` (`maxSpend(): Usd | Promise<Usd>`) — `BudgetScope.Execution` (a
  workflow's own `workflow: X`, or the default), `Tenant` and `Application` per
  `BudgetPeriod.Day | Week | Month`; every workflow, a tenant and the application covered at assembly
  (`[budget.*-required]`, `[budget.duplicate-…]`). `maxSpend()` is read once per execution, at its
  start (its `ExecutionContext` readable), and kept for the whole execution; an exhausted budget
  rejects the execution before the first step (`onExecutionRejected`), and every model call's cost is
  counted in all of them the moment it is made (#338: a live tally of the tree's pass, the ledger
  still written once per superstep) — the first exhausted stops it before the next step or call and
  aborts the calls in flight of its parallel branches (`executionContext.signal`; the launch fails
  with `BudgetExceededError`). Nothing is reserved: a small overrun on a race between executions is
  accepted, and a budget is exceeded by at most the calls in flight when it was exhausted. Hitting a limit **fails the
  execution** — unless an `.onError(…)` takes it — one class per limit, all `LimitExceededError`s:
  `StepsLimitExceededError` (`workflow`, `maxSteps`, `steps`), `VisitsLimitExceededError`,
  `BudgetExceededError` (`budget`, `scope`, `key`, `maxSpend`, `spent`: `tenant acme spent $40.05
today; tenant-daily-budget allows $40`).
- **Errors** (root entry) are `AGBossError`s with stable `code`s (`eval.case-invalid` —
  `EvalCaseInvalidError`, #396; `limit` ⊃ `limit.budget`,
  `limit.steps`, `limit.visits`, `limit.mesh-loop` / `limit.hops` (`MeshLoopDetectedError` /
  `HopsLimitExceededError`, #398: an A2A or MCP call chain — the `agboss-mesh` envelope every call
  made inside an execution carries — that comes back to an application's start or is longer than
  its `@Application({ maxMeshHops })`, default 8: the receiver refuses it before it runs, `409`, and
  the calling tool's step fails with it, never read by the model; with `@Application({ mesh: {
signingKey, peers } })` the envelope is a signed JWS and a peer the caller resolver names whose
  signature verifies is trusted: its budget becomes `caller-budget`, its deadline the execution's
  — `limit.deadline`, `DeadlineExceededError` —, its origin `executionContext.origin`, and its
  answer a signed run report the caller records as `ToolCallRecord.remote` and `a2a:<issuer>`
  spend — the larger of it and the `@A2AAgent`'s `price`; the envelope's `audience` is the client's
  `target.application`, another receiver refuses it, `401 mesh.audience-mismatch`), `step` ⊃ `step.failed` — `StepFailedError`, a step's own failure naming it (`component`, `nodeId`,
  `visitNumber`, `itemIndex`, #273 S22) — ⊃ `step.agent` / `step.action` (`ActionFailedError`, the
  action's error as `cause`) / `step.guard` (`GuardFailedError`: a guardrail's model did not answer —
  fails closed) / `step.router` ⊃ `step.router.invalid-decision` /
  `step.arbiter` (`ArbiterError`) / `step.quorum` (`QuorumNotReachedError`, #279) /
  `step.child` (`ChildExecutionFailedError`, #263) / `step.tool-blocked` (`ToolBlockedError`, #384),
  `limit.depth` (`DepthLimitExceededError`, #264),
  `compaction` (`CompactionError`, #120 PR 3),
  `pause.unknown`, `pause.wrong-answerer`, `pause.uninterpretable-reply`, `pause.no-reply-interpreter`,
  `execution.cancelled`, `app.stopping` — `ApplicationStoppingError`, `execute` / `resume` after
  `app.close()`, an `onExecutionRejected`, …); a new error
  class gets a `static code`. `.onError` matches by class, so a subclass is caught by its parent's
  side path.

### Testing

- The whole application: `testWith(Application, options?)` from `@agboss/core/testing` — the only form
  (`testWith(Workflow)` does not compile, #261); one workflow is tested through its start with
  `app.execute`. Each test assembles the application anew on the implementations it lists (else
  the in-memory defaults); `app` is built on first use (`await app.ready()` for a test that
  executes nothing). Vitest fixtures `app`, `mockLlm`, `mockAction`, `mockTool`, `mockOf` (budgets
  too), `mcpOf`,
  `recoverApp`, `clock` — the test's `VirtualClock` (`@agboss/core/testing`), the application's `Clock`
  in every test whatever it lists: fixed at `2026-01-05T09:00:00Z`, moved only by
  `await clock.advance(seconds(31))` (or `"25h"`), which sets the time first and then wakes every due wait in time order, each
  one's work before the next, without real waiting — so one advance of a whole lease (30 s) or more is a running
  execution's holder frozen that long, its lease over (#534, #551; let time pass for a live holder in steps of
  `seconds(10)`) — and work registered with `clock.track(promise)`
  (a store's round trip, #511) settled first, up to `new VirtualClock(start, { settleTimeout })`
  of real time (default 2 s, then `UnsettledWorkError`, `test.unsettled-work`); deterministic ids — `thread-1`, `thread-2`, …,
  `execution-1`, … in the order made, per test and shared by its instances (`SequentialIdGenerator`,
  `@agboss/core/testing`, #313), unless the application lists its own `IdGenerator` — and, with
  `testWith(App, { instances: 2 })`, `apps` (each instance its own container, one set of stores and
  one clock: a lease, a pause resumed on the other instance, a rate-limit slot — the in-memory
  defaults are shared; listed SQLite stores on `sqlitePath: ":memory:"` are **not**, each instance
  opens its own database, so a multi-instance test names one file, e.g. flow-patterns'
  `instances` environment on a temp path, #458) and `leases` (#471: `leases.stall(apps[0])` freezes
  that instance's lease store calls and lease timers while its steps run on, `leases.resume(…)`
  lets them go — a zombie writer on the `VirtualClock`); models answer by script — `replyWith(text)` or
  `replyWith(Dto, value, { cost })` (a structured answer, a class of the agent's output: checked by
  the generated types, #262), `callTool(Tool, args)` (args typed by the tool's input DTO),
  `routeTo(...targets)` (`Route<R>`: one target after `.chooseOne(…)`, the `OnDemand` ones before a
  launch, `routeTo()` only with an `Always` route), `decideWith(answers)` (a decision judge),
  `failWith(ModelFailure.Timeout)`, `waitFor(seconds(31))` (the next turn after that long on the
  clock); the network is blocked. `mockLlm(X).when(PartialValues<InputOf<X>>)` binds turns to the
  input values (agents, model routers and chat-model reply interpreters — `{ ask, reply }`, #267; a
  decision-model interpreter answers `decideWith({ approved: 0.9 })`;
  `undefined` = absent, lists by length and position,
  `variant(XDto, { … })` for a `oneOf` element); a call no script matches fails naming its input
  (`test.no-matching-script`). A script is an expectation: an unused `thenReturn` turn or `when(…)`
  fails a passing test at its end (`test.unused-script`; never `thenReturnAlways`) — a test that
  failed reports its own failure. Matchers by class: `toFollowPath`, `toFinishWith`,
  `rejects.toFailWith(ErrorClass, { …fields, cause })` (through the cause chain), for child workflows
  (#263) `toHaveChildExecutions(W, [{ item, finish | failedWith | cancelled }, …])` and
  `toHaveHandledError(E, { at, by })`, and the call
  matchers on `mockLlm(X)` / `mockAction(A)` (the action runs): `.inputs`,
  `toHaveBeenCalledWith(partial)`, `toHaveBeenCalledTimes(n)`, `toHaveReturned(XDto, fields?)` —
  Vitest's own on anything else. The project's `vitest.config.ts` wraps its `test` options in
  `agbossTest()` (`@agboss/core/testing/vitest`, #497): `server.deps.inline` gains `/@agboss\/core/`
  — installed from npm the core is external to vitest, and every file it loads by path (the
  application `workflowOf(W)` finds next to `W`, environments, eval suites) would bypass vite: no
  decorators, a second module graph — and `setupFiles` gains `@agboss/core/testing/setup` (once;
  the user's arrays merged, the rest passed through). Without it `workflowOf(W)` throws
  `TestSetupError` naming the fix when the application's import fails or lists another class named
  `W`; `npm run check:packed` (CI's `packed-project` job) proves both on the packed tarballs in a
  project of its own. Errors only the real way:
  `failWith`, a rejecting `mockOf`, `mockTool(Tool).thenFail(ToolFailure.Timeout)`, scripts that
  reach a limit (a budget: `mockOf(Budget).maxSpend` + a scripted cost), `app.cancel` / `signal`.
- A recorded run instead of scripts: `testWith(App, { vcr: { cassetteName, dir, mode: VCRMode.REPLAY } })`
  — an unrecorded call throws `CassetteMissingError` (REPLAY by default under `CI`). Recording builds
  the providers' gateway as `createApp` does (#439: `BuildOptions.gatewayOverProviders`, internal — the
  chat extensions loaded, a transport `@ModelProvider` created by the test app's container on its
  first call, its hooks first), so an offline transport records with no key; a replay creates none.
- Replacing a class in the application (#267 S104): `testWith(App, { overrides:
[override(RefundApprovalRole, AutoApproveChannel)] })` — the same `override(Class, Replacement)`
  as the unit runners, a class created instead of another over any listed one; a channel role's
  replacement need not extend it, but its `send` must fit the role's `ChannelAsk` →
  `ChannelOutcome` (else it does not compile). There is no `channels` option.
- Parallel branches (#262 S33): `testWith(App, { concurrency })` — `TestConcurrency.Sequential`
  (the default: one branch at a time, in listed / item order), `TestConcurrency.Real` (as in
  production, within `maxConcurrency`) or `TestConcurrency.inOrder([step(SkillsAgent),
step(CheckAgent, { company: { name: "Acme" } })])` — completions in that order through gates
  (`step(Node, partial)` is the matcher of `when`): a `FailFast`, a quorum or a cancel reproduced
  on every run; a step waiting at its gate is cancelled at once by a `FailFast`, a decided quorum or
  `app.cancel`; no branch can move and the next step is not waiting → `test.unreachable-step` at
  once; a step never reached fails the test at its end.
- Units — one component on its own container (#262 S55, S62, S89), no `new`: `testTool(Tool, {
overrides: [override(SearchClient, FakeSearchClient)], environment })` → `await run(input, {
timeout: seconds(1) })` → `{ output, spend }` (a tool call's frame: `executionContext.signal`
  with the timeout, `SpendRecorder` into `spend`; input and output validated); the same shape for
  `testAction`, `testRouter` (a code router's `route()`, or a model router with `model: routeTo(X)`
  / `decideWith(…)`), `testArbiter(A)(Agent, answer)`, `testRag(R)(query, { topK })`,
  `testToolInterceptor(I)` (#384: `.beforeToolCall(Tool, input)` → the `ToolCallDecision`,
  `.afterToolCall(Tool, input, output)`), `testJudge(J, { model: decideWith(…) | replyWith(…) })` (`{ variant, reply, task, attempt }`, its `reply` a plain object of the judge's DTO), `testGuardrail(G, { model: decideWith({ blocks: 0.9 }) })(text, { element })` → `{ isBlocked,
probability, refusal? }`
  and `testPii([Policies])` → `mask(text)` / `reveal(text)` (rules checked first: `-pii-policy`);
  `run.clock` is the runner's `VirtualClock`; the calls run for `{ tenantContext, tenant,
executionContext, execution }` as `testExecutionContext` takes them (checked by the classes'
  decorators), else the default tenant; with a held lease (`executionContext.fence`: token 1, the
  execution's own scope, confirmed for 30 s on the runner's clock), set by `fence: { token,
leaseExecutionId, confirmedUntil, isLost, confirmNowFails }` (#471). `testExecutionContext({ … })` stays for a class created
  by hand (a budget's `maxSpend()`), fakes from `@langchain/core/utils/testing`. Tests never call a
  real model; real-model checks are `make smoke`.
- A payment gateway's guarantees (#508, Wiki → Payment-gateways): `FakeOutboundGateway({ clock,
capabilities })` — a gateway in memory with `idempotencyKeys` (G1), `lookupByKey` (G2),
  `keyRetention` on the clock (G3), `firstResponseOnRepeat` (G4), `conflictOnMismatch` (G5), all on
  by default (`FULL_GATEWAY_CAPABILITIES`), `charge` / `lookup` / `payments`, faults by
  `injectFault(FakeGatewayFault.AnswerThenDrop | FailBeforeProcessing | Slow, { times, delay })`;
  `outboundGatewayChecklist({ send, lookup?, clock?, requiredRetention?, keyPrefix? })` probes G1–G5
  through a team's adapter → `{ results: [{ requirement, status: GatewayCheckStatus, evidence }],
isPassed }` — offline against the fake, by hand against a sandbox.

### Imports

An example (and any project) imports only the public entries: the root `agboss` (decorators,
DI, the path builder, settings, environments, observers, judges and decisions, `createApp`, errors,
types), `@agboss/core/dto` (+ the DTO wrappers), `/units`, `/models`, `/testing` (+ `/testing/setup`; `/testing/vitest`, #497, the vitest preset `agbossTest()`; `/testing/contracts`, #481, the store
contract suites), and
the integrations `/mcp`, `/rag`, `/a2a`, `/memory`, `/eval` (#396: `@EvalSuite` and the builders of
its cases and checks — no runner at import), and `/eslint` (#388: the lint rules for a
project's ESLint config; types from `@typescript-eslint/utils`, an optional peer). ESLint enforces it from
`packages/agboss/package.json#exports` minus `deprecatedExports` (`scripts/public-entries.mjs`): a
new entry is allowed by adding it there, never by an `eslint-disable`. `/core`, `/graph`, `/router`,
`/tool`, `/channels` are deprecated re-exports; `agboss migrate imports` rewrites them. The root
import has no side effects (load tracing, MCP, SQLite lazily), and each name has one meaning across
entries. A public surface change updates the api-extractor reports (`npm run api:update` →
`packages/agboss/api/*.api.md`). The framework never imports `examples/` (ESLint-enforced).

### Quality gates

`make check` = `npm run check`: the root allowlist (`.root-allowlist`), the suppression budget
(`.suppressions.json`), the install policy (`npm run check:installs`, #523: a workflow installs with
`npm ci`, an `npx` is pinned to an exact version, a script resolves ranges only with `--before` —
`RELEASE_CHECKLIST.md` → Dependency installs), no real-time threshold in a test (`npm run
check:real-time`), the generated `.agboss/types.d.ts` of the framework's test fixtures
(`npm run check:types`, #272 — before lint and `tsc`), build, the API reports, **compiled docs**,
prettier, ESLint, `tsc` (tests included; the examples' types written first), tests with coverage,
`agboss check --strict` on flow-patterns' two applications (warnings are errors, `--federation`
between them) and its own lint and `agboss check --models` on flow-patterns (`npm run check:models`). Compiled docs (`scripts/check-docs.mjs`) typecheck
every ` ```ts ` block of README, CLAUDE, QUALITY and WORKFLOW (and `docs/`) against the built
package — a doc whose snippets declare a `@Workflow` gets its `.agboss/types.d.ts` written first —
and check that every `scripts/…`, `npm run …`, `make …` and `agboss …` they mention — and every
`agboss …` the CLI prints — exists. CI also runs `node scripts/check-docs.mjs --wiki wiki` on the
Wiki that goes with the code (#341: a PR's `docs/wiki/<head branch>`, else `docs/wiki-pending`, which
`sync-wiki.yml` publishes; WORKFLOW.md): the same checks for every Wiki page, plus every link
between pages names an existing page. The Wiki changes outside PRs, so check it before publishing:
`node scripts/check-docs.mjs --wiki ../<repo>.wiki`. Snippet conventions (README, CLAUDE, Wiki alike):

- ` ```ts file=src/x.ts ` — written at that path, so other blocks of the same doc import it.
- A hidden `<!-- snippet-context … -->` comment right before a block supplies imports and
  declarations; a line `// @snippet` in it marks where the block goes (to wrap a fragment). A
  workflow snippet is loaded to write its types: its classes are real (exported), not `declare`d.
- ` ```ts no-check: <reason> ` opts a block out — the reason is required; use it sparingly.
- **One call per line in flow chains** (#289): `start(A)` / `.returns(B)` / `.toFinish(C)`, also
  `route(X)` / `.toFinish(F)`. `*.workflow.ts` and the flow fixtures (`FLOW_FILES` in
  `scripts/flow-style.mjs` = `.prettierignore`) are formatted by `make fmt`
  (`node scripts/format-flows.mjs`), not Prettier, and checked by ESLint
  (`@stylistic/newline-per-chained-call` + the formatting rules Prettier no longer applies there);
  a doc's ts block that builds a path is checked by `check:docs` (`doc:line: … (rule)`).

## Naming grammar (#127)

Names repeat the same patterns everywhere, so one name lets you guess the others (Wiki →
Components):

- **Kind as the suffix, qualifier in front**: `MainRouter`, `CoderAgent`, `ChatWorkflowFinish`;
  a component's `name` the same in kebab-case, its kind last (`main-router`, `coder-agent`,
  `chat-workflow-finish`, `charge-action`, `desk-workflow` — `[name.kind-suffix]`), unique in the
  application. DTO classes end with `Dto` (`OrderRequestDto`, `[dto.name]`); tool DTOs are noun
  pairs from one root (`FileRead` → `FileContent`, `FileWrite` → `FileWritten`).
- **Hierarchy rule (#141)**: a DTO that belongs to a component kind starts with that kind
  (`WorkflowStartTextDto`, `ToolCallApprovalDecisionDto`, `RagSearchResultDto`); paired concepts get paired
  names (`@WorkflowStart` / `@WorkflowFinish`, `WorkflowPauseQuestionDto` / `WorkflowPauseAnswerDto`);
  nothing "chat", "user", "human" or "person" in framework names — a run may be a CI pipeline, an
  approval may come from a system.
- **When + what** for things tied to a moment: `BeforeToolCallJudge`, `AfterToolCallJudge`,
  `BeforeAgentAnswerJudge`.
- **One limit → flat `max…`** (`maxVisits`); **several related → an object** named by what they
  are, the scope stated once (`circuitBreakerPolicy: { failureThreshold, window, openFor }`).
- **Closed sets are enums**, not string unions, in the public API.
- **One field name per meaning** across variants (`reason` for every verdict).
- **Full words.** Kept abbreviations: DTO, PII, MCP, RAG, JSON, CSV, CLI, URL, ID, API and the
  command `agboss`.
- Getting something for a component is `…Of` (`schemaOf`, `modelOf`); attaching is
  `<verb>(what).on(target)`; storage contracts are `…Repository` with Spring Data method names.
- **Values with units** — `usd(0.5)`, `seconds(30)`, `minutes(5)` (`@agboss/core/units`), no `Ms` /
  `Usd` in names; every timeout is one (`timeout: seconds(5)`), a join's waiting limit is its
  `deadline`.
- **`Workflow…` is the definition, `Execution…` one execution** (#268 AC10): `@Workflow`,
  `@WorkflowStart`, `WorkflowRecord` vs `app.execute`, `ExecutionOutput` (`executionId`),
  `ExecutionContext`, `ExecutionId`, `PausedExecution`, `ExecutionStatus`, the `onExecution…` hooks,
  `ExecutionCancelledError`; nothing execution-time is named `run…`.
- **The CLI takes full names** (#268): `--start chat-workflow-start`, `--workflow desk-workflow`,
  `agboss generate agent billing-agent` — the same string as `name`, traces and records. Inheritance (#120): lists add up, `exclude…` removes explicitly, a single setting
  has the same name on every level — no `override…` settings (`overrideArguments` is a corrected
  tool call, not inheritance).

## Conveyor

Stage = the `status:*` label: **Triage → Backlog → In progress → Test → Done** (Done: a human closes the issue).

| Stage              | Skill          | Output                                                                                                                     |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Triage             | `triage`       | business side (why / does / does not / constraints / acceptance criteria AC1…) in the issue; parent + sub-issues if needed |
| Backlog            | `spec-session` | spec, plan, tests + manual checks mapped to every AC, test cases in the issue                                              |
| In progress → Test | `implement`    | parallel waves; branch + PR (`Refs #N`) per issue, merged to `main`; manual-test handoff                                   |

Quizzes: `.claude/skills/QUIZ.md`. Stages: `scripts/ticket.sh status <N> <Status>`.

## Hard rules

- Read `WORKFLOW.md` (tracker, wiki, branches, PRs) and `QUALITY.md` (code, types, agents, FinOps,
  tests) before writing code.
- Tracker is GitHub Issues via `gh`. Every change belongs to an issue.
- Never commit to `main` directly. Branch from `main`: `<type>/<issue>-<slug>`.
- Every domain concept gets a named type; reusable code is generic.
- Every model call records usage; models come only from the registry.
- Never lower coverage thresholds, disable lint rules, or add `eslint-disable` / `@ts-ignore`
  to get green. Fix the code or stop and report.
- The gate enforces it (#180): `.suppressions.json` is a budget of every `eslint-disable`,
  `@ts-ignore`, `as any` and `as unknown as` — `make check` fails when a count goes up, and when it
  goes down until the budget is lowered (`node scripts/check-suppressions.mjs --write`). No
  file-scope `/* eslint-disable */`, ever. Tests must assert (`requireAssertions`) and must not fake
  framework failures (e.g. an interrupt by its name). The repo root is allow-listed
  (`.root-allowlist`): notes and specs go to Issues / Wiki.
- Tests never call a real LLM. An application is tested with `@agboss/core/testing` (`testWith`: models
  by script, MCP servers stubbed, network blocked); units use fakes from `@langchain/core/utils/testing`.
- Read existing code before planning — the spec may be stale, the code is not.
- **No specs, plans or docs as files.** Specs and implementation plans → GitHub Issues (bodies via
  stdin). Docs → GitHub Wiki via `scripts/wiki.sh`. **ALWAYS update the `../<repo>.wiki` repository directly whenever making API, DSL, or architectural changes so that the wiki is always up-to-date** — checked with `node scripts/check-docs.mjs --wiki ../<repo>.wiki` before `scripts/wiki.sh publish`, and by CI. Decisions → wiki pages `ADR-NNNN-Title`.
- Inside the framework, `src/routers` never imports graph/agents/prompts, and the rest imports it
  only via `src/routers/index.ts` (ESLint-enforced; the same for `src/tools` and `src/terns`).
- **Example code before spec**: a new decorator or a new parameter enters a spec only after example
  code using it is agreed.
- New names follow the naming grammar (above, #127).
- Screenshots and scratch output go to `.artifacts/` (git-ignored).

## Layout

```
packages/agboss/        the framework (npm package `@agboss/core`; builds to dist/; no command — see -cli)
  src/
    index.ts        the root entry `@agboss/core` (public/: components, flow, observers, app) + errors.ts
    application/    @Application, createApp(App) → app.execute / resume / cancel / close / checkLiveness /
                    checkReadiness over every workflow,
                    the application's assembly rules, its one container
    app/            one workflow of an application at run time; app-deps.ts — its wiring (model gateway,
                    MCP, tracing) on the application's infrastructure
    infrastructure/ the contracts + in-memory defaults (ledger, records, paused executions, leases,
                    tree keys, rate-limit slots); sqlite/ — the connection and every Sqlite* one
    budgets/        @Budget, BudgetScope, BudgetPeriod, BudgetHandler; the rules; at run time: the checks,
                    the counting and the live tally (execution-budgets.ts; maxSpend() once per
                    execution in run/run-budgets.ts)
    health/         @HealthCheck, HealthCheckResult, HealthReport + the rules (health-check.ts, in the
                    root import); the probes, loaded on first use (application-health.ts, #300)
    testing/        `@agboss/core/testing`: testWith(App) (Vitest fixtures), scripted gateway, matchers, setup.ts
                    contracts/ — `@agboss/core/testing/contracts`: the published store contract suites (#481)
    components/     @Tool @Agent @McpServer @McpTool @Rag @Injectable @Workflow, DI container, workflowOf
    dto/            `@agboss/core/dto`: field decorators, DTO schemas and validation, standard/ DTOs
    units/          `@agboss/core/units`: usd(), seconds(), minutes(), kilobytes()
    workflow.ts     the assembled workflow type
    config/         typed config schema, profiles (YAML overlays), defaults resolution
    rag/            knowledge-base contract (RagConnector) + reference SQLite FTS5 connector
    flow/           the paths (#272): builder.ts (start/agent/router/action/route/caseOf/to…), ast.ts,
                    decorators/ (@WorkflowStart @Router @Agent @Action @WorkflowFinish @Workflow),
                    dto-wrappers.ts, handlers.ts, print.ts (the grammar printed); analyse/ (path walk,
                    scope and data flow, rules/), types/ (`.agboss/types.d.ts` generation),
                    runtime/ (the StateGraph per workflow: build.ts, state.ts, scope, runners/,
                    limits, onError, input messages, records)
    graph/          the agent loop (agent-loop/: its subgraph, tools, approval, judges), knowledge,
                    rule-error.ts, limits.ts, settings.ts, studio-graph.ts
    llm/  routers/  tools/  guardrails/  compaction/  terns/  run/  pause/  finops/  tracing/
    prompts/  types/
    loader/, describe/   loadWorkflow (tsx); describeApplication (`agboss describe`, through agboss/internal)
                    and its parts — the tree, channels, PII policies, the worst-case report;
                    describeWorkflow (internal: one workflow's part); studio.ts (studioOf: the graphs of agboss studio)
    federation/     `agboss check --federation` (#398 PR 4): the snapshots read, the contracts compared
                    (federation.ts) and JSON Schemas compared structurally (schema-compat.ts), through agboss/internal
    eval/           `@agboss/core/eval` (index.ts, #396): suite/ — @EvalSuite, the case and check builders, their
                    assembly (check-suite.ts, through agboss/internal); run/ — `agboss eval run`'s
                    runner (run-suite.ts) and its artifact (report.ts); eval.ts, golden, replay, compare —
                    the CLI's eval, golden, replay and compare (through agboss/internal)
    eslint/         `@agboss/core/eslint` (#388): `agbossPlugin` (`agboss/no-component-state`,
                    `agboss/no-direct-time`) and `FLOW_CHAIN_RULE` — for the eslint.config.js `agboss
                    create` writes and for this repo's own config (so lint runs on the build)
    internal.ts     `@agboss/core/internal`: what the CLI is built on — not public, not for projects
  tests/            unit tests (helpers.ts = fakes; fixtures/ = test workflows); routers/ alone; smoke/ = real
  schema/           profile.schema.json (YAML autocomplete)
packages/agboss-cli/    the `agboss` command (#205, npm package `@agboss/cli`; depends on @agboss/core, same version)
  src/
    cli/            main.ts → run-cli.ts (argv → exit code 0/1/2 usage/3 project/4 conflict/5 quality, --json
                    envelope), commands.ts (one option schema per command: parser + help), terminal helpers
    scaffold/       `agboss create` / `agboss generate` (templates/ next to src/)
    migrate/        `agboss migrate imports` (#195): rewrites the old entries' imports to the new ones
    chat.ts, cli.ts, check.ts, describe.ts, dev.ts, studio.ts, rag-index.ts, eval/   command handlers
  tests/            CLI tests; workflows come from the framework's tests/fixtures
  bin/              the CLI launcher (bin names `agboss` and `agboss`)
examples/flow-patterns/      the one in-repo example (#489: job-scout is agbossjs/agboss-examples' 08-job-scout) —
                    the flow's patterns (package flow-patterns-example, #295): src/offer/ (a review loop),
                    src/credit/ (a code router beside a model router), src/review/ (parallel launches
                    in waves, #273), src/panel/ (a quorum, #279), src/vendor/ (a child workflow per
                    item, #263), src/topic/ (recursion, #264), src/approvals/ (two approvals at once,
                    #267), src/hiring/ (declared compensation, #339), src/travel/ (a failed join's undo, #340),
                    src/desk/ (the extension points, #382–#385), src/helpline/ (its A2A consumer, #398,
                    with an MCP server), src/intake/ (quorum groups, #279),
                    each domain only kind folders (#474): workflows/<w>/ (the *.workflow.ts with its
                    starts and finishes), dto/, agents/<n>/ (+ <n>.prompt.md) and the other prompted
                    kinds in their own folders; tests/ mirrors src/; model-providers/; desk.application.ts (offline, served over
                    A2A); snapshots/ (its describe --json); eval/ (its eval baseline, labels and
                    failure tags); data/policies/ (what the MCP server reads); scripts/ (npm run
                    answer); README.md (real runs,
                    #346); tests/
scripts/        the gate's checks (check-root, check-suppressions, check-docs + docs/, api-report,
                public-entries, eslint-agboss-plugin: `@agboss/core/eslint` on the repo's files),
                bootstrap-repo, bootstrap-labels, ticket, wiki,
                langfuse, coverage-badge
../<repo>.wiki  GitHub Wiki working copy (separate git repo, never inside this repo)
```
