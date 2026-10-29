# Examples: `agboss-examples` (01–07), `job-scout` & `flow-patterns`

AGBoss provides two complementary repositories of runnable, CI-verified examples so you can prove compile-time and runtime guarantees locally for `$0` and inspect production-grade reference architectures.

1. **[`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) (`01-hello-agboss` through `07-langgraph-migration`)** — seven standalone, runnable applications that depend on the distributed `agboss` and `agboss-cli` packages, enforce the canonical `1 class = 1 file` component subfolder layout and symmetric Spring-style `tests/` mirroring `src/`, and verify every framework guarantee offline (`$0`).
2. **In-repository packages (`examples/job-scout/` and `examples/flow-patterns/`)** — `examples/job-scout/` (resume → search brief → Greenhouse jobs ranked by Jev → company notes RAG → MCP shortlist) and [flow-patterns](#flow-patterns-a-review-loop-and-a-code-router) (the zero-cost harness of the public surface).

## How the 7 standalone verified applications work (`agbossjs/agboss-examples`)

Every project in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) follows **`Promise → Failure Injection → Reproducible Proof`**:

| Project | Primary Engineering Proof |
| :--- | :--- |
| **[`01-hello-agboss`](https://github.com/agbossjs/agboss-examples/tree/main/01-hello-agboss)** | Clean `agboss create` project layout (`1 class = 1 file`, `src/workflows/hello-agboss/`, `src/agents/<name>/` with `.prompt.md`), real async HTTP service DI (`PricingCatalogService` passing `ExecutionContext.signal` + `step.idempotencyKey`), production HTTP server (`src/http/server.ts` with `202 Accepted` on pauses and `/health/live` + `/health/ready` probes), and symmetric `tests/` (`mockOf`, `testWith`). |
| **[`02-path-scope-proof`](https://github.com/agbossjs/agboss-examples/tree/main/02-path-scope-proof)** | Static dataflow proof across 4 cases (`01-missing-input`, `02-outdated-data`, `03-parallel-invalidation`, `04-uncompensated-action`) showing `[input.missing-on-path]`, `[input.outdated-on-path]`, `[launch.branch-outdates-sibling]`, and `[flow.uncompensated-action]` passing `tsc --noEmit` in raw LangGraph (`langgraph-broken/`) while caught before runtime by `agboss check` (`agboss-broken/` vs `agboss-fixed/`). |
| **[`03-support-refund-desk`](https://github.com/agbossjs/agboss-examples/tree/main/03-support-refund-desk)** | Reversible `@PiiPolicy` (`replaceWithToken`, `revealPii: true`, `PiiRefusedError`), `@ToolInterceptor` (`replyToModel`, `block`), `@InputGuardrail` (`DecidedBy.Code`), `@OutputGuardrail`, in-memory BM25/TF-IDF `@Rag` (`InMemoryKnowledgeIndexService` + `RefundPolicyRetriever`), `PolicyAwareCompaction` vs policy drift, and 5-layer `@EvalSuite` with compact git-tracked `eval/baseline/main-baseline.json` and `agboss eval calibrate` (Cohen's $\kappa$). |
| **[`04-travel-booking-saga`](https://github.com/agbossjs/agboss-examples/tree/main/04-travel-booking-saga)** | Reverse-order LIFO saga compensation (`@Action({ compensateWith, committedBy })`) across `payment-saga`, `budget-saga`, `quorum-saga` (`.joinQuorum({ min: 2, max: 2 })`), and `hitl-hold-saga` (`Channel.withdraw()`, `NotPausedError`), idempotent external ledgers (`step.idempotencyKey`), SQLite WAL crash recovery, and HTTP `202 Accepted` pause adapter. |
| **[`05-cluster-work-stealing`](https://github.com/agbossjs/agboss-examples/tree/main/05-cluster-work-stealing)** | Distributed child work-stealing (`.toParallelWorkflows(ChunkWorkerWorkflow, { placement: ChildPlacement.AnyInstance })`, `SqliteChildExecutionQueueRepository`), recursive `ThisWorkflow` (`maxDepth: 2`), 30s SQLite leases & fencing (`ExecutionLeaseLostError`), `maxConcurrentSteps: 2` backpressure (`HealthComponentKind.StepSlots`), `@HealthCheck`, and `IncompatibleResumeError`. |
| **[`06-enterprise-agent-mesh`](https://github.com/agbossjs/agboss-examples/tree/main/06-enterprise-agent-mesh)** | 3-service mesh (`apps/1-order-gateway`, `apps/2-billing-a2a`, `apps/3-catalog-mcp`) over `@A2AAgent` / `@A2AExpose` and `@McpTool` / `@McpExpose`, Ed25519 `agboss-mesh` JWS envelope, `MeshLoopDetectedError` & `HopsLimitExceededError`, MCP `_meta.callId` deduplication (`SqliteMeshRequestRepository`), and `agboss check --federation` Blast Radius. |
| **[`07-langgraph-migration`](https://github.com/agbossjs/agboss-examples/tree/main/07-langgraph-migration)** | Side-by-side comparison of raw `@langchain/langgraph` (`before-langgraph/support.graph.ts` with 15-field `Annotation.Root` God State, string-keyed `addConditionalEdges`, unbounded `Send()`, dynamic prompt interpolation) vs AGBoss (`after-agboss/src/` + `after-agboss/tests/` with 10 narrow `@Dto`s, `@Router`, bounded `.toParallelAgents()`, `@Action`, `@Channel`, and `agboss check --strict`). |

---

## job-scout

`examples/job-scout/` — the full in-repo example, a separate package that depends on `agboss` exactly
like an outside project (only its public API; ESLint-enforced). Resume from disk → a proposed search
brief → Greenhouse jobs ranked by Jev → explained with the user's company notes → the chosen ones saved to a
shortlist, after the user approves the write. Its second, smaller neighbour,
[flow-patterns](#flow-patterns-a-review-loop-and-a-code-router), holds the flow's patterns the CLI can be pointed at.

```bash
npm install && npm run build          # repo root
cd examples/job-scout
npm run chat                          # "my resume src/data/sample-resume.md" → brief → "ok" → ranked jobs
npm run describe                      # the paths, each node's inputs, agents, tools — no API key
npm run types                         # .agboss/types.d.ts (agboss check; run by typecheck)
```

## Flow

One path per turn (#272): the message goes to the main router (Jev, `maxVisits: 1`), which sends
it to the agent that answers; that agent's answer finishes the turn, and the thread carries the
conversation to the next one.

```ts no-check: the example's own file, compiled by its package (src/job-scout.workflow.ts)
flow: [
  start(ChatWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toRouter(MainRouter)
    .chooseOne(
      route(ProfilerAgent).toFinish(ChatWorkflowFinish),
      route(ScoutAgent).toFinish(ChatWorkflowFinish),
      route(ShortlistAgent).toFinish(ChatWorkflowFinish),
    ),
],
```

1. **profiler-agent** reads the resume (`read-resume-tool`: PDF, Markdown, text) and proposes a search brief — where,
   roles, deal-breakers, count, boards. Reply `ok` or say what to change.
2. **scout-agent** calls `greenhouse-jobs-tool` once per brief: public Greenhouse boards, hard filters, then Jev rates
   every remaining job (`JobFitJudge`); the answer is always a numbered list with links, then "why the top
   matches" from the user's **company notes** (`search-company-notes-rag-tool`, cited as `[file]`). Ask "why is
   Fireblocks a fit?" — the answer cites `[fireblocks.md]`.
3. **shortlist-agent** saves the jobs the user names ("save 1 and 2") to `~/job-scout/shortlist.md` through the
   official filesystem MCP server — the write **waits for the user's approval** (`approve? [y/N]`); rejected →
   nothing written. "What is on my shortlist?" lists it.

A search turn costs about $0.02; the others well under a cent.

## Components — every kind, by file convention

```
src/job-scout.application.ts        @Application job-scout-application — its workflow, budgets, defaults (DEFAULTS) and environment contract; no infrastructure listed → in memory (#261)
src/config/budget.config.ts         @Budget application-daily-budget | tenant-daily-budget | execution-budget
src/job-scout.workflow.ts           @Workflow job-scout-workflow — the paths, its window (uncompactedTurns), guardrails, compaction (compactions/conversation.compaction.ts), MCP, providers, channels; limits and model providers in settings()
src/workflow-starts/, routers/, workflow-finishes/   @WorkflowStart chat-workflow-start → @Router main-router → @WorkflowFinish chat-workflow-finish
src/agents/*.agent.ts + *.prompt.md @Agent profiler-agent | scout-agent | shortlist-agent (text agents, promptUrls)
src/tools/read-resume.tool.ts       @Tool ← ResumeReader
src/tools/greenhouse-jobs.tool.ts   @Tool ← JobFitJudge, JOB_SEARCH, GreenhouseBoards
src/mcp/shortlist.server.ts         @McpServer (filesystem, only ~/job-scout/; read_text_file, write_file)
src/mcp/save-shortlist.mcp.ts       @McpTool — adds the chosen jobs, skips links already there (channel: TerminalUserChannel)
src/mcp/read-shortlist.mcp.ts       @McpTool — the shortlist as saved
src/services/                       greenhouse-boards (HTTP), resume-reader (files, PDF), job-fit (Jev) — @Injectable
src/rag/company-notes.rag.ts        @Rag company-notes-rag (SQLite FTS5, topK 3, RagMode.Tool) over notes/companies/
src/model-providers/                @ModelProvider openrouter (retries, circuit breaker, costs from the response)
src/environments/                   app.environment.ts (the contract) + dev / staging / test
src/config/                         search.config.ts (boards, places), settings, paths, prompt variables
src/scripts/probe-boards.ts         `npm run probe -- --place israel <token…>`
src/data/sample-resume.md
```

`notes/companies/*.md` are **samples** (Fireblocks, JFrog, Similarweb, AppsFlyer, Taboola) — replace them
with what you know; `npm run rag:index` re-indexes. Every agent has an output ceiling, and the workflow
avoids the OpenRouter provider Inceptron for `kimi-k2.6` (it loops on tool-call arguments — #97).

## Profiles and comparisons

`profiles/job-scout-workflow/scout-low-thinking.yaml`, golden set `golden/job-scout-workflow/core.yaml`
(a task is a text for the text start, or a thread's start line `start chat-workflow-start: {"text":"…"}`,
replayed at that start):

```bash
npm run compare -- --profiles base,scout-low-thinking --golden core
```

## flow-patterns: a review loop and a code router

`examples/flow-patterns/` (package `flow-patterns-example`, #295) — the zero-cost harness of the
public surface (#419): twelve workflows, one per `*.workflow.ts`, in one application (`src/flow-patterns.application.ts`: `app.execute` runs each by
its start, #261), on the public entries only, tested by script (no model key, no cassette). They are
what the manual checks of the flow point the CLI at; `make check` runs `agboss check --strict` on the
application and on the offline `src/desk.application.ts`, each with `--federation` (below; then
`agboss check --models --env test`, which needs no key), the example's own lint (`eslint.config.js` with `@agboss/core/eslint`, as `agboss
create` writes it), the desk's eval suite offline (`npm run eval:check`, below) and its tests with
coverage (`isolate: false`: one module graph per worker, each test assembling its application anew). Besides the two below: `src/review/` (parallel launches in waves,
#273), `src/panel/` (a quorum, [Parallel](Parallel)), `src/vendor/` and `src/topic/` (a child workflow
per item and recursion, [Workflow as a step](Workflow-as-a-step)), `src/approvals/` (two approvals at
once, below).

Each domain holds kind folders only (#474, [Components](Components#project-layout-474)): the
workflow with its starts and finishes in `workflows/<w>/` (`src/credit/workflows/credit/credit.workflow.ts`,
`credit.workflow-start.ts`, `order-held.workflow-finish.ts`), each agent, router, judge, arbiter,
compaction and guardrail in its own folder (`src/credit/agents/approval/approval.agent.ts` +
`approval.prompt.md`), DTOs in `dto/`, errors in `errors/`. `tests/` mirrors `src/`: a workflow's
tests in `tests/<domain>/workflows/<w>/` (with its `support/` and `__snapshots__/`), a component's
unit test at its module's path (`tests/credit/repositories/payment-ledger.repository.test.ts`).

```bash
npm install && npm run build          # repo root
cd examples/flow-patterns
npx agboss describe                   # every workflow of its application: the offer's two paths, the
                                      # reviewer's inputs by producer, credit-limit-router  code — …
npm run check                         # agboss check --strict on the application (writes .agboss/types.d.ts)
npm test
```

- **`src/offer/`** — the review loop of [Workflow](Workflow): draft-agent → reviewer-agent; the
  reviewer is reached from the draft and from the editor, so
  `agent(ReviewerAgent).returns(oneOf(ChangesRequestedDto, DraftApprovedDto)).switch(…)` is a path
  of its own, and the change requests are about the draft:
  `caseOf(ChangesRequestedDto, { about: OfferDraftDto })`. The editor has `maxVisits: 2`; the refused third visit is taken by
  `.onError(VisitsLimitExceededError, toAction(NotifyRecruiterAction).toFinish(OfferFailedWorkflowFinish))`.
  The reviewer reads `historyOf(OfferDraftDto, { limit: 1 })` — `{ current, previous }`, the draft and
  the one before it. Moving the `switch(…)` inline after `.toAgent(ReviewerAgent)` makes `agboss check` fail with
  `[flow.shared-node-inline]`.
- **`src/credit/`** — a code router beside a model router ([Routers](Routers)): desk-router (Jev)
  sends an order to order-intake-agent; credit-limit-router (`DecidedBy.Code`) decides in
  `route(input)` with `CreditService` and `ExecutionContext` through `deps` — a $50 order goes to
  charge-card-action, a $500 one to approval-agent. `CreditServiceUnavailableError` from the
  service (the `RouterFailedError`'s cause) is taken by `.onError(…, toFinish(OrderHeldWorkflowFinish))`;
  any other error fails the run with `RouterFailedError`.
- **`src/desk/`** — the four extension points around one agent (#382–#385): `desk-agent` runs on
  `harness/desk`, served by `HarnessModelProvider` (`src/model-providers/`), a transport
  `@ModelProvider` whose `complete(request)` looks the `#<id>` order up, then quotes the tool — no
  key, no network. Beside it the application lists the built-in `OpenRouterModelProvider` and
  `DecisionsModelProvider` — catch-alls that yield `harness/…` to the transport that claims it
  (#454, [Model providers](Model-providers#which-provider-serves-a-model)). The agent has two code guardrails (`decidedBy: DecidedBy.Code`:
  credentials in the question, a promised date in the answer), a `@ToolInterceptor` that blocks
  `close-account-tool`, answers for an archived order (`replyToModel`) and cuts a status's internal
  note (`afterToolCall`), and the workflow a `CompactionStrategy.Custom` compaction past a two-turn
  window. `src/desk.application.ts` lists the same workflow with the transport alone, so
  `PII_PSEUDONYM_KEY=offline-only npx agboss run --application src/desk.application.ts --env offline
  --start desk-workflow-start --input '{"customerId":"c-1","question":"Where is order #7?"}'`
  answers offline (`offline`: the stores in memory, only the PII key read — the desk's PII policy
  makes tokens with it outside tests).
  The same agent carries the operational contracts: a code `@Judge` that reads the visit's
  `toolCalls` (`maxRetries: 1`, then `QualityGateError`), a `@Rag` it searches
  (`search-shipping-policy-rag-tool`), and the workflow a `PiiPolicyHandler` detector
  (`<customer-id:…>` in what the model reads); the application lists an observer, a `@HealthCheck`
  (`app.checkReadiness()`) and `maxConcurrentSteps: 16`. Each unit runner runs on the patterns' own components in the test that mirrors the
  component (`tests/credit/routers/credit-limit/credit-limit.router.test.ts`, …) — `testAction` with an `override`, `testRouter`,
  `testArbiter`, `testRag`, `testPii`, and `testJudge` on the tool calls of a scripted visit.
- **`src/helpline/`** — two applications over [A2A](A2A) (#398): `desk-application` serves
  `desk-workflow-start` (`@A2AExpose` in `@Application({ exposes })`; its caller resolver takes the
  tenant from an `x-tenant-id` header, for callers on the same host only), and the helpline's
  `ask-desk-tool` calls it through `DeskA2AAgent`, an `@A2AAgent` contract with its own
  `DeskCallDto`. `npm run check` runs `agboss check --federation` twice, no network: the desk
  against its checked-in `snapshots/desk-application.json` (a changed export without a new
  `version` is `[federation.version-not-bumped]`), and the application against the desk's fresh
  `agboss describe --json` — renaming a field of `DeskCallDto` gives
  `[federation.incompatible-schema] … — affects flow-patterns-application › helpline-workflow
  (ask-desk-tool)`. `npm run snapshot` rewrites the desk's snapshot. `tests/desk/a2a/desk.a2a-expose.test.ts` serves
  the desk with the `a2aServer` fixture and calls it with the helpline's contract
  (`new A2AClient({ url, headers, contract })`); the consumer's own test replaces the remote with
  `mockOf(DeskA2AAgent)`.
  The helpline also reads the customer policies (`data/policies/`) through the official filesystem
  [MCP](Mcp) server — `@McpServer` `policy-files` over stdio, its `read-policy-tool` an `@McpTool`;
  `tests/helpline/workflows/helpline/helpline-mcp.test.ts` never starts it, `mcpOf(PolicyFilesServer)` answers `read_text_file`.
- **`src/intake/`** — a quorum by groups ([Parallel](Parallel), #279): a full legal check and a quick
  screen side by side, `.joinQuorumGroups(group(LegalCheckAgent).priority(1)…, group(FastScreenAgent)
  .priority(2)…, { deadline: seconds(30) })`. `tests/intake/workflows/intake/intake.workflow.test.ts` fixes the order the branches
  finish in with `TestConcurrency.inOrder([step(…), step(…)])`: the full check first wins
  (`result.launches[0].group`, the screen cancelled); the full check's model failing
  (`failWith(ModelFailure.RateLimited)`) lets the quick screen's group go on.
  The desk's [eval suite](Eval-Suites) (`src/desk/eval-suites/desk.eval-suite.ts`:
  `checkTrajectory()`, then the code `desk-answer-judge` on the finish's text) runs on the same
  transport: `npm run eval:check` is `agboss eval run --env offline --runs 2 --baseline
  eval/runs/desk-eval-suite.json --fail-on-regression` (no key, fake prices only), `agboss eval show
  --html` of the checked-in baseline and `agboss eval calibrate` on `eval/labels/desk-eval-suite.jsonl`
  — two labelers, one of whom fails the archived-order answers (`asks-instead-of-answering`, from
  `eval/failure-taxonomy.yaml`): κ, the confusion per labeler and the judge's `length` / `quotesTool`
  metrics over the disagreements. `npm run eval` rewrites the baseline (relabel after). `agboss eval
  score` is not part of it: it scores with Jev, which needs OpenRouter.
  The desk keeps each execution 30 days (`executionRecordRetention`, [Execution history](Execution-history),
  #401) in `.agboss/desk-offline.sqlite` on `--env offline`: `npm run records:check` runs it once,
  exports the kept records (`agboss records export --tenant default --out .agboss/records/desk.jsonl`)
  and drafts an eval case from the newest (`agboss generate eval-case lookup-from-history --suite
  desk-eval-suite --from-execution <id> --dry-run`) — what `agboss eval ui`'s "Save as golden case"
  (#397 PR 5) writes into the suite.
  `tests/desk/workflows/desk/desk-cassette.test.ts` replays the desk from a [VCR](Testing#vcr--recorded-runs) cassette,
  `tests/desk/workflows/desk/__snapshots__/desk-lookup.cassette.json`, recorded offline through the same transport
  (`AGBOSS_VCR_MODE=RECORD npx vitest run tests/desk/workflows/desk/desk-cassette.test.ts`, #439); `npm run check` runs
  `agboss check --cassettes` on the desk, so a changed prompt or schema is `[vcr.stale-cassette]`
  until `AGBOSS_VCR_MODE=RECORD_STALE` records what changed.
- **`src/approvals/`** — two approvals at once ([Pauses](Pauses), #267): `offsite-booking-workflow`
  launches venue-buyer-agent and flight-buyer-agent side by side; each calls `place-purchase-tool`,
  whose `@Tool({ channel: PurchaseApprovalChannel })` names a role
  (`answeredBy: PauseAnswerer.ThreadOwner`) implemented by `TerminalPurchaseApprovalChannel`, listed
  in `@Application({ providers })`: it prints each question once, with its pause's id, and waits
  (`ChannelOutcome.awaitReply()`). The execution rests with two pauses in `result.pending`; every
  store of the application is SQLite, so they wait across processes. `npm run answer -- <pauseId…>
  [--decline]` answers waiting pauses from another process — two at once, or a second press that
  gets `NotPausedError`. In the tests, `testWith(FlowPatternsApplication, { instances: 2, env:
  "instances" })` pauses on one instance and resumes both pauses on the other
  ([Several instances](Several-instances)): the `instances` environment puts the SQLite stores in one
  fresh file, since `:memory:` is one database per connection.

### Real runs of flow-patterns (#346)

The `dev` environment calls real models: `openRouterApiKey: secret("OPENROUTER_API_KEY")` and
`openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")` for the built-in OpenRouter providers,
`PII_PSEUDONYM_KEY` for the application's PII key, and the SQLite stores in
`.agboss/flow-patterns.sqlite`; `test` has neither key — the tests script every model. Langfuse traces
a run when its `LANGFUSE_*` keys are set (`scripts/langfuse.sh up` writes them to the repo's `.env`),
and only then. The example's `README.md` walks through the manual checks it serves — #263 M1 (the
vendor screening's children in Langfuse), #264 M1 (the topic research, `maxDepth: 3`,
`maxConcurrentExecutions: 4`) and #267 M1 (two approvals at once):

```bash
cd examples/flow-patterns
set -a && . ../../.env && set +a      # OPENROUTER_API_KEY, PII_PSEUDONYM_KEY, LANGFUSE_*
npx agboss run --start vendor-screening-workflow-start \
  --input '{"text":"check these vendors: Acme, Globex, a vendor that does not exist"}'
npx agboss run --start topic-research-workflow-start \
  --input '{"title":"the history of computing","level":0}'
npx agboss run --start offsite-booking-workflow-start \
  --input '{"text":"Offsite: Lakeside Lodge for $1800, flights TLV to LIS for $2400"}'
npm run answer -- <first pause id> <second pause id>   # from a second terminal
```
