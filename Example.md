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

1. **profiler-agent** reads the resume (`read_resume`: PDF, Markdown, text) and proposes a search brief — where,
   roles, deal-breakers, count, boards. Reply `ok` or say what to change.
2. **scout-agent** calls `greenhouse_jobs` once per brief: public Greenhouse boards, hard filters, then Jev rates
   every remaining job (`JobFitJudge`); the answer is always a numbered list with links, then "why the top
   matches" from the user's **company notes** (`search_company_notes`, cited as `[file]`). Ask "why is
   Fireblocks a fit?" — the answer cites `[fireblocks.md]`.
3. **shortlist-agent** saves the jobs the user names ("save 1 and 2") to `~/job-scout/shortlist.md` through the
   official filesystem MCP server — the write **waits for the user's approval** (`approve? [y/N]`); rejected →
   nothing written. "What is on my shortlist?" lists it.

A search turn costs about $0.02; the others well under a cent.

## Components — every kind, by file convention

```
src/job-scout.application.ts        @Application job-scout-application — its workflow, budgets, defaults (DEFAULTS) and environment contract; no infrastructure listed → in memory (#261)
src/config/budget.config.ts         @Budget application-daily-budget | tenant-daily-budget | execution-budget
src/job-scout.workflow.ts           @Workflow job-scout-workflow — the paths, its own defaults (history), guardrails, compaction, MCP, providers, channels; limits and model providers in settings()
src/workflow-starts/, routers/, workflow-finishes/   @WorkflowStart chat-workflow-start → @Router main-router → @WorkflowFinish chat-workflow-finish
src/agents/*.agent.ts + *.prompt.md @Agent profiler-agent | scout-agent | shortlist-agent (text agents, promptUrls)
src/tools/read-resume.tool.ts       @Tool ← ResumeReader
src/tools/greenhouse-jobs.tool.ts   @Tool ← JobFitJudge, JOB_SEARCH, GreenhouseBoards
src/mcp/shortlist.server.ts         @McpServer (filesystem, only ~/job-scout/; read_text_file, write_file)
src/mcp/save-shortlist.mcp.ts       @McpTool — adds the chosen jobs, skips links already there (channel: TerminalUserChannel)
src/mcp/read-shortlist.mcp.ts       @McpTool — the shortlist as saved
src/services/                       greenhouse-boards (HTTP), resume-reader (files, PDF), job-fit (Jev) — @Injectable
src/rag/company-notes.rag.ts        @Rag company_notes (SQLite FTS5, topK 3, RagMode.Tool) over notes/companies/
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

`examples/flow-patterns/` (package `flow-patterns-example`, #295) — two workflows, one per
`*.workflow.ts`, in one application (`src/flow-patterns.application.ts`: `app.execute` runs each by
its start, #261), on the public entries only, tested by script (no model key, no cassette). They are
what the manual checks of the flow point the CLI at; `make check` runs `agboss check` on both, their
lint (flow style) and their tests with coverage.

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

