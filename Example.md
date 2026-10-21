# Example: job-scout

`examples/job-scout/` — the full example, a separate package that depends on `agboss` exactly
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

`examples/flow-patterns/` (package `flow-patterns-example`, #295) — seven workflows, one per
`*.workflow.ts`, in one application (`src/flow-patterns.application.ts`: `app.execute` runs each by
its start, #261), on the public entries only, tested by script (no model key, no cassette). They are
what the manual checks of the flow point the CLI at; `make check` runs `agboss check --strict` on the
application (then `agboss check --models --env test`, which needs no key), their lint (flow style)
and their tests with coverage. Besides the two below: `src/review/` (parallel launches in waves,
#273), `src/panel/` (a quorum, [Parallel](Parallel)), `src/vendor/` and `src/topic/` (a child workflow
per item and recursion, [Workflow as a step](Workflow-as-a-step)), `src/approvals/` (two approvals at
once, below).

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
  Moving the `switch(…)` inline after `.toAgent(ReviewerAgent)` makes `agboss check` fail with
  `[flow.shared-node-inline]`.
- **`src/credit/`** — a code router beside a model router ([Routers](Routers)): desk-router (Jev)
  sends an order to order-intake-agent; credit-limit-router (`DecidedBy.Code`) decides in
  `route(input)` with `CreditService` and `ExecutionContext` through `deps` — a $50 order goes to
  charge-card-action, a $500 one to approval-agent. `CreditServiceUnavailableError` from the
  service (the `RouterFailedError`'s cause) is taken by `.onError(…, toFinish(OrderHeldWorkflowFinish))`;
  any other error fails the run with `RouterFailedError`.
- **`src/approvals/`** — two approvals at once ([Pauses](Pauses), #267): `offsite-booking-workflow`
  launches venue-buyer-agent and flight-buyer-agent side by side; each calls `place-purchase-tool`,
  whose `@Tool({ channel: PurchaseApprovalChannel })` names a role
  (`answeredBy: PauseAnswerer.ThreadOwner`) implemented by `TerminalPurchaseApprovalChannel`, listed
  in `@Application({ providers })`: it prints each question once, with its pause's id, and waits
  (`ChannelOutcome.awaitReply()`). The execution rests with two pauses in `result.pending`; every
  store of the application is SQLite, so they wait across processes. `npm run answer -- <pauseId…>
  [--decline]` answers waiting pauses from another process — two at once, or a second press that
  gets `NotPausedError`.

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
