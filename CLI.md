# CLI — `agboss` / `agboss`

`agboss help` lists every command; `agboss help <command>` shows its options.

## Create and generate (Angular-like)

```bash
npx agboss create support-desk          # alias: agboss c — asks for the structure, writes the project, runs npm install
cd support-desk && cp .env.example .env && npm run chat
```

The questionnaire asks only for the structure: the agents (name + role), each agent's tools, an MCP
server (none / filesystem / own command), a knowledge base (none / notes in a folder). Models (Kimi),
the Jev main router, the 8 192-token ceiling, limits and a prompt-injection guardrail
(`guardrails/prompt-injection.guardrail.ts`) get defaults written into the code. Every
answer has a flag, for scripts and CI:

```bash
agboss c support-desk --yes --agents "triage:Sorts requests,answerer:Answers questions" \
  --tools "answerer:search_orders" --mcp filesystem:/path/to/docs --rag notes --skip-install
```

The skeleton runs at once: tools return a marked placeholder (`TODO`), prompts are drafted from the roles,
every tool has a test (`testTool(XTool)`) and the workflow has one on `testWith`
(`src/<workflow>/<workflow>.workflow.test.ts`: the main router and the first agent by script — it runs
offline, [Testing](Testing)). Files follow the [conventions](Components#file-conventions): `*.agent.ts` + `*.prompt.md`, `*.tool.ts` + `*.tool.test.ts`, `*.server.ts` + `*.mcp.ts`, `*.rag.ts`, and the flow's `workflow-starts/text.workflow-start.ts` (`TextWorkflowStart`, named `<workflow>-text-workflow-start`), `routers/main.router.ts` (`<workflow>-main-router`), `workflow-finishes/text.workflow-finish.ts` (`TextWorkflowFinish`, `<workflow>-text-workflow-finish`) — names carry the workflow, so a second workflow in the project never clashes; a text-only MCP server tool replies with `PlainTextDto`. The workflow is one path ([Workflow](Workflow)): `start(TextWorkflowStart).returns(WorkflowStartTextDto).toRouter(MainRouter).chooseOne(route(TriageAgent).toFinish(TextWorkflowFinish), …)` — the main router chooses the agent that answers, each agent's text finishes the run — with limits in `settings()`. The environments go to `environments/` (`environment.ts`, `dev` and `staging`). `npm run types` (`agboss check`) writes `.agboss/types.d.ts` — run on install (`postinstall`) and by `npm run check` (= types + tsc + `npm test`). `vitest.config.ts` has three projects by file name — `unit`
(`*.test.ts`), `integration` (`*.integration.test.ts`), `suites` (`*.suite.test.ts`, real models); empty
ones pass. `npm test` runs unit + integration, the `test:suites` script the suites.

```bash
agboss g agent billing   --workflow src/support-desk/support-desk.workflow.ts --description "Handles invoices"
agboss g router escalation --workflow src/support-desk/support-desk.workflow.ts                # routers/escalation.router.ts
agboss g tool refund     --workflow src/support-desk/support-desk.workflow.ts --agent billing
agboss g mcp tickets     --workflow … --command tickets-mcp --tool search --agent billing   # or --dir <folder>
agboss g rag policies    --workflow … --folder policies --agent billing
agboss g workflow onboarding                                        # a second workflow + npm scripts chat:onboarding, …
```

Each part is **wired** (the TypeScript Compiler API edits the `@Agent` / `@Workflow` / `@Router` arrays,
the flow and imports): a new agent joins the main router's choice — a route `{ prompt: "Handles invoices", target: BillingAgent }` in
`routers/main.router.ts`'s `routes`, and `route(BillingAgent).toFinish(TextWorkflowFinish)` after the
last `route(…)` of `.toRouter(MainRouter).chooseOne(…)`. A new router gets the answer route only and is
**not** put into the flow — where it sits is your choice. At its end `agboss generate` regenerates
`.agboss/types.d.ts`.
Nothing existing is overwritten — a clash or an unexpected file shape is an error, and nothing is
written; `--force` regenerates the files and keeps the existing wiring. `agboss g openapi <name> --url <spec>`
writes one tool per OpenAPI 3 operation (DTOs, a client in `services/`, tests), wired into `--agent`.

## The application and its starts (#268)

Every command but the generators works on **one application**, whose path the project sets once in
its `package.json`:

```json
{ "agboss": { "application": "src/job-scout.application.ts" } }
```

The path is relative to the folder of that `package.json` (the nearest one from the working
directory up); `--application <path>` (relative to the working directory) wins over it. Neither set →
exit 3, `No application: set "agboss": { "application": "src/<name>.application.ts" } in package.json,
or pass --application <path>`; the module must export exactly one `@Application` class
(`application.load`, exit 3); a missing `--application` file is a usage error (exit 2). There is no
`--workflow <path>` on these commands (the generators keep theirs until #268 PR 4 — see below).

The commands that **run one workflow** — `chat`, `run`, `eval`, `replay`, `golden add`, `compare` —
choose it by its start, **by the start's full name**, the same string as in `name`, traces, records
and `agboss describe` (a start belongs to exactly one workflow; a child workflow's starts count too):

```bash
agboss chat                                                    # the application has one start
agboss run --start inbox-workflow-start "Where is order 7?"    # a start taking WorkflowStartTextDto
agboss run --start screening-workflow-start --input '{"name":"Acme"}'
agboss run --start batch-screening-workflow-start --input-file companies.json
agboss eval --start screening-workflow-start
agboss golden add --start screening-workflow-start --name smoke --from-last 20
agboss compare --start screening-workflow-start --profiles base,cheap-router --golden smoke
```

- With **one start** in the application `--start` may be omitted.
- With **several** and none given → exit 2, the starts listed with their description and workflow:
  `The application has 4 starts: choose one with --start <name> — inbox-workflow-start (A message to the
  inbox; inbox-workflow), batch-screening-workflow-start (Companies to screen at once;
  screening-workflow), …` (workflow by workflow as the application lists them, each one's starts by name).
- A name no start has → exit 2: `Start "screening" not found. Did you mean "screening-workflow-start"?
  The starts: …`. The hint is only a message — the lookup is exact, the CLI never adds a suffix, and
  nothing runs under a guessed name.

`agboss run` takes its input once: a text (`"<task>"`, only for a start whose input is
`WorkflowStartTextDto`), `--input '<json>'` or `--input-file <file>`. The value is checked against the
start's `InputOf` — one DTO, a `listOf(…)` or a map of fields — **before the app starts**, every
problem at once by field, exit 2:

```
stderr: agboss run: --input does not fit the input of criteria-screening-workflow-start: company.name: Invalid input: expected string, received undefined; request.criteria: Invalid input: expected string, received number — see agboss help run
```

(Errors stay one line on stderr, #198: the list of starts and the field problems are joined with `, `
and `; `.) `agboss chat` sends what is typed as a text, so its start takes `WorkflowStartTextDto`.

## Run, inspect, evaluate

| Command | What it does |
| --- | --- |
| `agboss chat [--start <name>]` | interactive chat (`--thread`, `--profile`, `--env`), on [`app`](App) |
| `agboss run [--start <name>] "task"` | one execution, the answer to stdout (`--input <json>` / `--input-file <file>` for a start taking a DTO), on [`app`](App) |
| `agboss check` | writes `.agboss/types.d.ts`, then assembles the whole application (every flow rule of every workflow at once), checks the environment (its secrets' values only with `--models`) — the components every workflow's start creates — and the prompts — exit 3 on any problem; no key ([Workflow](Workflow#generated-types)) |
| `agboss describe` | every workflow of the application in turn (the listed ones, then their child workflows): the paths as written, each node's inputs with their producers, each value written `{ about }` (`reviewer-agent → DraftChangesDto { about: DraftDto }`, [Path scope](Path-scope#outdating-current-values-only)), `historyOf` fields with their limit, each model with the provider it resolves to (`model: … → openrouter-model-provider`, #266), agents, tools, dependencies, knowledge bases, settings, config hash; the application (#261): each infrastructure contract's implementation and why (listed / built-in default), the budgets by scope with their periods and the execution budget that caps each workflow (own or default), the observers, the assembly warnings; the limits (`maxSteps` set or default, each node's `maxVisits`, the worst case of each start) — no key. `--json`: `{ application: { name, version }, workflows: [ … ] }` |
| `agboss check --strict` | the same, the analyser's warnings (`[flow.path-too-deep]`, `[graph.child-without-failure-finish]`) and the application's assembly warnings (`[application.in-memory-cost-ledger]`, `[application.in-memory-pauses]`, #261) errors — exit 3; without `--strict` they are printed as `warning: …` lines ([Workflow as a step](Workflow-as-a-step#errors)) |
| `agboss check --models` | every model setting of every workflow of the application against what its resolved provider says the model supports — all problems at once, exit 1 on any; no model call, but it connects, so the chosen environment's secrets must be set — a missing one names its variable ([Model providers](Model-providers#fail-fast-settings-must-fit-their-models)) |
| `agboss eval` / `agboss replay` `[--start <name>]` | score recent runs of the start's workflow with Jev / re-run a prompt version |
| `agboss golden add [--start <name>] --name <n>` | recent real tasks of the start's workflow as a golden set |
| `agboss compare [--start <name>] --profiles base,<p>` | profiles side by side on the start's workflow ([Profiles and comparisons](Profiles-and-comparisons)) |
| `agboss rag index [--rag <name>]` | build / update every knowledge base of the application, each once (one bound by two agents too); `--rag` one by its full name — an unknown one is exit 2 with a `Did you mean "…"?` and the list ([Knowledge bases](Knowledge-bases)) |

Every command that loads the application takes `--env <name>` and `--application <path>`; exit codes
are 0 ok · 1 internal · 2 usage (an unknown option, start or knowledge base, an input that does not
fit) · 3 invalid project (no application path, a module without one `@Application`, an assembly
problem) · 4 conflict.

`agboss chat` and `agboss run` build the application with `createApp` (the profile applied), send the
input to the chosen start, print the finish's output, ask in the terminal about each pause the
thread's owner answers and continue it with `app.resume({ pauseId, decision })` ([Pauses](Pauses)),
and close the app (components' `onStop`, MCP servers) at the end. `eval`, `replay`, `golden` and
`compare` assemble the application and work on the start's workflow — a `--profile` is that
workflow's own (`profiles/<workflow>/<name>.yaml`).

The generators (`agboss generate <kind> <name> --workflow src/x/x.workflow.ts`) still take the
workflow's module path; #268 PR 4 turns it into the workflow's full name (`--workflow
job-scout-workflow`). A project made by `agboss create` gets `"agboss": { "application" }` in its
`package.json` and scripts without a path (`"chat": "agboss chat"`,
`"rag:index": "agboss rag index"`, `"types": "agboss check"`); a workflow added by `generate workflow` has its own application
until then, and its scripts name it (`agboss chat --application src/onboarding/onboarding.application.ts`).

`agboss migrate imports [<path>…]` rewrites imports of the deprecated entries to the current ones (the list:
`agboss help migrate`).

Note: `agboss` is also the oh-my-zsh git plugin's alias for `git commit` — `npx agboss` in a project always works.

## "Star us on GitHub" line

An interactive call ends with one line on **stderr**, after the command's own output (also when the
command fails; the exit code is unchanged):

```
⭐ Like AGBoss? Star us on GitHub: https://github.com/agbossjs/agboss
```

It is never written to stdout, and it is hidden when stderr is not a terminal (pipes, scripts), `CI`
is set, `--json` or `--quiet` is passed, or `AGBOSS_NO_STAR=1`. `agboss help` lists the variable.
