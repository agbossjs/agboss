# CLI — `agboss`

`agboss help` lists every command; `agboss help <command>` shows its options.

## Create and generate (Angular-like)

```bash
npx agboss create support-desk          # alias: agboss c — asks for the structure, writes the project, runs npm install
cd support-desk && cp .env.example .env && npm run chat
```

`agboss create <project>` writes **an application and its first workflow** (#268 AC8): the
application `src/support-desk.application.ts` (`support-desk-application`; its path is
`"agboss": { "application" }` in the project's `package.json`), beside it what every workflow shares —
`environments/` (the contract, `dev`, `staging`, `test`), `config/budget.config.ts`,
`model-providers/openrouter.model-provider.ts`, `guardrails/prompt-injection.guardrail.ts` (listed in
`@Application({ guardrails })`, its model `defaults.guardrail.model`) and `services/api.service.ts` —
and the first workflow `support-desk-workflow` in `src/support-desk/`.

The questionnaire asks only for the structure: the agents (full name + role), each agent's tools (full
names), an MCP server (none / filesystem / own command), a knowledge base (none / notes in a folder).
Models (Kimi), the Jev main router, limits and the guardrail get defaults written into the code. Every
answer has a flag, for scripts and CI — **full names only**:

```bash
agboss c support-desk --yes --agents "triage-agent:Sorts requests,answerer-agent:Answers questions" \
  --tools "answerer-agent:search-orders-tool" --mcp filesystem:/path/to/docs --rag notes --skip-install
```

The skeleton runs at once: tools return a marked placeholder (`TODO`), prompts are drafted from the roles,
every tool has a test (`testTool(XTool)`) and the workflow has one on `testWith`
(`src/<project>/<project>.workflow.test.ts`: the main router and the first agent by script, in the
application — it runs offline, [Testing](Testing)). Files follow the
[conventions](Components#file-conventions): `*.agent.ts` + `*.prompt.md`, `*.tool.ts` +
`*.tool.test.ts`, `*.server.ts` + `*.mcp.ts`, `*.rag.ts`, and the flow's
`workflow-starts/text.workflow-start.ts` (`TextWorkflowStart`, named
`<workflow>-text-workflow-start`), `routers/main.router.ts` (`<workflow>-main-router`),
`workflow-finishes/text.workflow-finish.ts` (`TextWorkflowFinish`, `<workflow>-text-workflow-finish`)
— names carry the workflow, so a second workflow never clashes; a text-only MCP server tool replies
with `PlainTextDto`. The workflow is one path ([Workflow](Workflow)):
`start(TextWorkflowStart).returns(WorkflowStartTextDto).toRouter(MainRouter).chooseOne(route(TriageAgent).toFinish(TextWorkflowFinish), …)`
— the main router chooses the agent that answers, each agent's text finishes the run. The scripts run
a workflow by its start's full name (`"chat": "agboss chat --start support-desk-text-workflow-start"`,
`run` the same), so they keep working when the application gets more workflows; `npm run types`
(`agboss check`) writes `.agboss/types.d.ts` — run on install (`postinstall`) and by `npm run check`
(= types + tsc + `npm test`). `vitest.config.ts` has three projects by file name — `unit`
(`*.test.ts`), `integration` (`*.integration.test.ts`), `suites` (`*.suite.test.ts`, real models); empty
ones pass. `npm test` runs unit + integration, the `test:suites` script the suites.

Generated code follows the [conventions](Components#conventions): explicit return types,
`implements …Handler` (`ToolHandler<In, Out>`, `BudgetHandler`), `@Injectable`s named by their role
(`ApiService`, the OpenAPI client `PetsApiService`) and fields named after their type
(`private readonly apiService: ApiService`), the execution through the constructor
(`deps: [ExecutionContext]`, `private readonly executionContext: ExecutionContext`) and code outside
an execution through `deps: [ApplicationContext]` (`private readonly applicationContext:
ApplicationContext`).

```bash
agboss g agent billing-agent --workflow support-desk-workflow --description "Handles invoices"
agboss g router escalation-router --workflow support-desk-workflow           # routers/escalation.router.ts
agboss g tool refund-tool --workflow support-desk-workflow --agent billing-agent
agboss g mcp tickets --workflow support-desk-workflow --command tickets-mcp --tool search --agent billing-agent   # or --dir <folder>
agboss g rag policies-rag --workflow support-desk-workflow --folder policies --agent billing-agent
agboss g arbiter valid-score-arbiter --workflow support-desk-workflow --agent billing-agent
agboss g workflow onboarding-workflow      # a second workflow of the application + chat:onboarding, run:onboarding
```

**Names are full names** (#268 AC8) — the same string as in `name`, traces, records and
`agboss describe`, so `grep "billing-agent"` finds every use: the positional name ends with its kind
(`-agent`, `-router`, `-arbiter`, `-tool`, `-rag`, `-workflow`; an MCP server is named as its
server, `tickets`), `--workflow` is a workflow's full name and `--agent` an agent's. The CLI never
adds a suffix: `agboss g agent ranker` is exit 2 — `"ranker" is not a full agent name: kebab-case,
ending with -agent. Did you mean "ranker-agent"?` — and an unknown workflow or agent is exit 2 with
`Workflow "desk" not found in src/desk.application.ts. Did you mean "desk-workflow"? Workflows: …`;
nothing is written. The workflow is found in the application — `"agboss": { "application" }` of
`package.json`, or `--application <path>` —, its children included, read from the source (nothing is
run).

Each part is **wired** (the TypeScript Compiler API edits the `@Agent` / `@Workflow` / `@Router` /
`@Application` arrays, the flow and imports): a new agent joins the main router's choice — a route
`{ prompt: "Handles invoices", target: BillingAgent }` in `routers/main.router.ts`'s `routes`, and
`route(BillingAgent).toFinish(TextWorkflowFinish)` after the last `route(…)` of
`.toRouter(MainRouter).chooseOne(…)`. A new router gets the answer route only and is **not** put into
the flow — where it sits is your choice. `generate workflow` writes the workflow in a folder beside
the application file (`src/onboarding/`, its test there too) and lists its class in
`@Application({ workflows })` — a name the application already has is a conflict (exit 4). At its
end `agboss generate` regenerates `.agboss/types.d.ts`. Nothing existing is overwritten — a clash or
an unexpected file shape is an error, and nothing is written; `--force` regenerates the files and
keeps the existing wiring. `agboss g openapi <name> --url <spec>` writes one tool per OpenAPI 3
operation (DTOs, a client `services/<name>-api.service.ts`, tests; each tool `<operation>-tool`), wired
into `--agent`.

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
`--workflow <path>` on any command; `agboss generate` takes `--workflow <full name>`
([above](#create-and-generate-angular-like)).

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
| `agboss check [--env <name>]` | writes `.agboss/types.d.ts`, then assembles the whole application (every flow rule of every workflow at once), prints [the report](#the-check-report-268) — the worst case of one call of each start, with `--env` the process variables that environment needs — checks the environment (its secrets' values only with `--models`) — the components every workflow's start creates — and the prompts — exit 3 on any problem; no key ([Workflow](Workflow#generated-types)) |
| `agboss describe` | [the whole application](#describe-268): its tree of workflows, starts and children, each contract's implementation and why, the model providers, the channels, the budgets, the environment; then every workflow (the listed ones, then their child workflows) — no key. `--json`: `{ application: { name, version, tree, implementations, modelProviders, channels, budgets, executionBudgets, maxConcurrentSteps, … }, workflows: [ … ] }`, each workflow with its [declarative snapshot](#the-declarative-snapshot-268) |
| `agboss check --strict` | the same, the analyser's warnings (`[flow.path-too-deep]`, `[graph.child-without-failure-finish]`) and the application's assembly warnings (`[application.in-memory-cost-ledger]`, `[application.in-memory-pauses]`, #261) errors — exit 3; without `--strict` they are printed as `warning: …` lines ([Workflow as a step](Workflow-as-a-step#errors)) |
| `agboss check --models` | every model setting of every workflow of the application against what its resolved provider says the model supports — all problems at once, exit 1 on any; no model call, but it connects, so the chosen environment's secrets must be set — a missing one names its variable ([Model providers](Model-providers#fail-fast-settings-must-fit-their-models)) |
| `agboss eval` / `agboss replay` `[--start <name>]` | score recent runs of the start's workflow with Jev / re-run a prompt version |
| `agboss golden add [--start <name>] --name <n>` | recent real tasks of the start's workflow as a golden set |
| `agboss compare [--start <name>] --profiles base,<p>` | profiles side by side on the start's workflow ([Profiles and comparisons](Profiles-and-comparisons)) |
| `agboss dev [--strict]` | watch mode: `agboss check` rerun in a short-lived process on every change of the application's `src/` — the types regenerated, the problems printed ([below](#watch-mode-and-studio-268)) |
| `agboss studio [--port N]` | LangGraph Studio on every workflow of the application, a child drawn inside its parent — no `studio.ts` / `langgraph.json` in the project ([below](#watch-mode-and-studio-268)) |
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

A project made by `agboss create` gets `"agboss": { "application" }` in its `package.json` and
scripts without a path — `"chat": "agboss chat --start <project>-text-workflow-start"`,
`"describe": "agboss describe"`, `"rag:index": "agboss rag index"`, `"types": "agboss check"`; a
workflow added by `generate workflow` joins the same application and gets `chat:<name>` /
`run:<name>` by its own start.

## Watch mode and Studio (#268)

```bash
agboss dev                 # Ctrl+C to stop
agboss studio              # http://localhost:2024, Studio opens in the browser
agboss studio --env prod --port 2077
```

**`agboss dev [--strict] [--env <name>]`** watches the application's `src/` (the nearest folder of
that name above the application module, else the module's folder) and, on every change of a source,
prompt, profile or JSON file — `node_modules/`, `dist/` and `.agboss/` aside — runs `agboss check` on
the application in a **short-lived child process**: the ESM / tsx module cache cannot reload a graph
in a long-lived one. So `.agboss/types.d.ts` follows the code and the assembly problems are printed as
they appear. The changes of 200 ms are one pass; a change during a pass makes one more after it; two
passes never run at once. It runs one pass at start, prints `dev: watching src — Ctrl+C to stop`, then
`dev: changed <files>` before each pass; Ctrl+C (or SIGTERM) waits for the pass that runs and exits 0.

**`agboss studio [--port N] [--env <name>]`** needs no `studio.ts` and no `langgraph.json` in the
project. It builds every workflow of the application — the listed ones and the child workflows they
launch, on the chosen environment — as the server will, so an assembly problem or a missing variable
stops it with exit 3 before any server starts; then it writes the git-ignored `.agboss/studio.ts` (one
export per workflow, built by `studioOf` from `agboss/internal`) and `.agboss/langgraph.json` (one graph
per workflow, named by the workflow's full name; the project's `.env` when it has one) and runs
LangGraph's dev server on them (`langgraphjs dev --config .agboss/langgraph.json --port N`, from
`@langchain/langgraph-cli`, a dependency of `agboss-cli`). Both files are rewritten on every run.

What Studio shows (S37): a child workflow is a **subgraph inside its parent** — entered by an edge
(`.toWorkflow(W)`, `route(W)`) or one per item (`.toParallelWorkflows(W, …)`), its steps drawn as
`vendor-check-workflow:vendor-checker-agent` in the parent's graph — and also a graph of its own
(it runs alone through its own starts). `ThisWorkflow` is the node `this-workflow`, never its own
subgraph; `getGraphAsync({ xray: true })` marks it `recursive: maxDepth N` in the node's metadata,
which Studio's graph endpoint does not pass on (its JSON keeps a node's id, type and name only) — so
Studio shows a plain node there (an open question of #268 PR 3). Studio's own runs are limited by
steps and visits; budgets are opened per execution by the app ([FinOps](FinOps)).

## describe (#268)

`agboss describe` prints the application first, then each workflow — from the decorators, with no
key, no network and no project code run (no `maxSpend()`):

- **The tree** — the workflows `@Application({ workflows })` lists, each with its starts (and their
  input) and, below it, the child workflows it launches, by which step, one or one per item, down to
  their own children; `ThisWorkflow` is the workflow again, marked with its `maxDepth`.
- **Implementations** — each infrastructure contract's class and why (listed in `@Application
  providers` / built-in default); **model providers** — the listed ones, else the built-ins, each
  with what it `serves` ([Model providers](Model-providers)).
- **Channels** — each one a tool names: a role's question → answer (an approval role's question is
  the tool input it approves; the answer `ToolCallApprovalDecisionDto`), who answers, its reply
  interpreter and its one implementation with why; a concrete `@Channel` named by the tool is used
  as is ([Pauses](Pauses)).
- **Budgets** by scope with their periods, and the execution budget of each workflow — its own or
  the default — which applies when it is the root of `app.execute`; nested, it spends from its
  root's. Then the observers, the instance's cap on steps (`maxConcurrentSteps 32 (set)`, or
  `none (not set)`, #332), the assembly warnings and the environment (secrets masked).
- **Each workflow** — its guardrails and PII policies with their refusals (the text, or
  `ClassName.refusal()` when the class computes it), the paths as written, each node's inputs with
  their producers (`prepare-offer-action ← draft: editor-agent | draft-agent (latest), …`), each
  value written `{ about }`, the start each edge into a child enters through, its limits —
  `maxSteps` (set or default), each node's `maxVisits`, `maxDepth`, `maxConcurrentExecutions` and
  the worst case of each start ([below](#the-check-report-268)) — `model → provider`, its agents,
  tools, dependencies, knowledge bases and settings; each agent's compaction and `uncompactedTurns`
  with where they came from (`(own)`, the workflow's or the application's name, `(built-in)`,
  [Memory Management](Memory-Management)); each action that declares its undo
  (`register-offer-action  compensateWith withdraw-offer-action · committedBy confirm-offer-action`,
  #339, [Rollback](Rollback)).

```
vendor-screening-workflow 1.0.0
  start vendor-screening-workflow-start (WorkflowStartTextDto)
  child vendor-check-workflow 1.0.0 per item from vendor-finder-agent (maxItems 20, maxConcurrency 3)
    start vendor-check-workflow-start (VendorDto)
topic-research-workflow 1.0.0
  start topic-research-workflow-start (TopicDto)
  child topic-research-workflow (ThisWorkflow, recursive, maxDepth 3) per item from subtopics-action (maxItems 5, maxConcurrency 3)
```

### The declarative snapshot (#268)

`agboss describe --json` gives, per workflow, the whole declarative spec its records and traces
join on (S92 / S93) — no code is generated back into TypeScript. Next to the facts the text prints,
each entry of `workflows[]` has:

| Field      | What                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `configHash` | the workflow's fingerprint — the one join key: the same in `WorkflowRecord`, every execution event, `executionContext.workflow` and the records ([Observability → Join keys](Observability#join-keys)) |
| `starts`, `finishes` | its starts' and finishes' names                                                                                     |
| `nodes`    | every node: `name`, `kind` (`ComponentKind`), `description`, `promptHash`, `schemaHash`, `input` / `output` (each DTO as `{ dto, schemaHash }`, wrappers as `listOf` / `oneOf` / `optional` / `historyOf` / `fields`), `maxVisits`; an agent's `agent` — `model`, `provider`, `reasoning`, `maxTokens`, `maxModelCalls`, `maxToolCalls`, `uncompactedTurns`, `compaction`, `tools`, `rag` (`name`, `mode`, `topK`), the `guardrails` and `piiPolicies` in effect after the application → workflow → agent cascade, `judges`, `maxRetries`, `instructions`; a router's `router` — `decidedBy`, `model`, `provider`, `instructions`, its `routes` with `spawn` and `failure`; an action's `action` — `compensateWith`, `committedBy` (component names, #339), only when it declares one |
| `edges`    | every edge: `from`, `to`, `kind` (`next`, `case`, `route`, `error`, `launch`, `join`, `join-error`), what it `writes` (`value`, `about`, `isCase`), the `error` class of a side path, a quorum group's agents |
| `onError`  | the `.onError` / `.onJoinError` table: `at`, `error` (the class), `by` (the side path's first node), `kind`                  |
| `launches` | every launch: `launcher`, `targets`, `isPerItem`, `maxConcurrency`, `maxItems`, its `quorum` (`{ kind, min, max, deadline }` or its `groups`) and its arbiters — each `.acceptedBy(…)` in path order, an `anyOf` as one list — with `decidedBy`, `model` and `promptHash` |
| `schemas`  | `dtos` — every DTO on its paths by class name, `{ schemaHash, jsonSchema }`; `tools` — every tool by name, `{ promptHash, schemaHash, input, output }` (JSON Schemas) |

A hash that does not apply is left out (`promptHash` of an action, `schemaHash` of a node that
declares no `input` or `output`). The hashes are the ones a run gives: an execution's events carry
the same `configHash`, and each step's `component` the same `promptHash` and `schemaHash`.

```
$ agboss describe --json | jq '.result.workflows[0] | { configHash, node: .nodes[1] | { name, kind, promptHash } }'
{
  "configHash": "b9e483788522…",
  "node": { "name": "draft-agent", "kind": "agent", "promptHash": "10b63db2aa5c…" }
}
```

## The check report (#268)

`agboss check` prints, after the assembly, what one call of each start may cost in counts — the same
rule as the [start log](App#at-start-the-log-the-warnings-describe): only what the decorators say. Each number says how it is made up:
`maxItems` and `maxConcurrency` of the launches on the way (multiplied out level by level), each
workflow's `maxSteps` or its longest path, `maxDepth` of a workflow launching itself, and the tree's
`maxConcurrentExecutions` when it is lower than the executions alive at once:

```
flow-patterns-application 1.0.0, environment prod

Worst case of one vendor-screening-workflow-start call
  workflow executions     21  1 vendor-screening-workflow + 20 vendor-check-workflow (maxItems 20)
  at the same time        4   1 vendor-screening-workflow + 3 vendor-check-workflow (maxConcurrency 3)
  agent and router steps  22  2 in vendor-screening-workflow (longest path) + 20 × 1 in vendor-check-workflow (longest path)
  nesting depth           2   vendor-screening-workflow → vendor-check-workflow

prod environment needs 3 process variables:
  OPENROUTER_API_KEY   secret
  OPENROUTER_BASE_URL  value, optional
  AGBOSS_SQLITE_PATH   value, has a default
```

With `--env <name>` it lists the process variables that environment needs — names only, each
`value` or `secret`, `optional` / `has a default` when it may stay unset, never a value
([Environments](Environments#the-cli)). `--json` carries the report as `result.report`: `title`,
`starts` (`start`, `workflow`, `rows` of `measure`, `total`, `madeUp`) and `environment`
(`name`, `variables`).

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
