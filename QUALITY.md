# QUALITY

> Paths below are in `packages/agboss/` (the framework).

Rules the code must satisfy. `make check` enforces what a machine can; the rest is checked in
self-review before every PR.

## Design

- **SRP.** One module = one reason to change. One graph node per file.
- **DRY.** Second copy of logic → extract. Third copy is a defect.
- **Small units.** Files ≤ 200 lines (lint-enforced), functions ≤ 50 lines, cyclomatic
  complexity ≤ 10.
- **Dependency injection over globals.** Models, tools and clients are passed in (factory
  arguments), never imported as singletons. This is what makes graphs testable.
- **Components keep no state (#261).** One container per application instance, one instance per
  class; an execution may continue on another instance after a pause. Read the execution from
  `ExecutionContext`, keep data that outlive a step in the graph state, and caches or deduplication
  in a service over external storage — never `this.x = …` outside the constructor (lint
  `agboss/no-component-state`) and never a `Map<executionId, …>` in a component.
- **Pure core, effectful edges.** Business logic is pure; I/O (LLM, network, fs) sits at the
  boundary behind a small interface.
- **Names say intent.** `routeToolCall`, not `handle`. Booleans read as questions: `isFinal`,
  `hasToolCalls`. Full words; kept abbreviations: DTO, PII, MCP, RAG, JSON, CSV, CLI, URL, ID, API
  (and `id`, `url`, `llm` in code).
- **Naming grammar (#127)** for every public name: kind as the suffix (`MainRouter`,
  `CoderAgent`; DTOs are noun pairs — `FileRead` → `FileContent`), when + what for moments
  (`BeforeToolCallJudge`), `max…` for one limit and a `limits` object for several, enums for closed
  sets, one field name per meaning, `…Of` for getting something for a component,
  `<verb>(what).on(target)` for attaching, `…Repository` for storage contracts, values with units
  (`usd()`, `seconds()`), `override…` only for replacing what is inherited.
- **Example code before spec.** A new decorator or parameter enters a spec only after example code
  using it is agreed.
- **Refactor while green.** Only after tests pass; never mix refactor and behaviour change in
  one commit.

## Types — the code is fully typed

Types are documentation that the compiler checks. A reader must understand **what a variable
holds from its type**, not guess it from the name.

- **Every domain concept has a named type.** Object shapes → `interface`; unions, function
  types, mapped types → `type`. No anonymous object types in exported signatures, no
  `Record<string, unknown>` / `object` / bare `string` where a domain type exists.
  - ✗ `function run(cfg: { key: string; m: string }): Promise<string>`
  - ✓ `function run(config: ModelConfig): Promise<AgentAnswer>`
- **Generics for reusable abstractions.** Nodes, tool wrappers, result types, repositories,
  retry helpers are generic with constraints (`<TState extends object>`) — not copy-pasted per
  type and not widened to `unknown`. With more than one parameter, name them: `TState`,
  `TUpdate`, `TInput`, `TOutput`. See `src/graph/types.ts`.
- **Branded types for primitives that can be confused**: IDs, model slugs, thread ids, amounts.
  `type ModelId = Brand<string, "ModelId">` (`src/types/brand.ts`). The brand is applied once,
  at the validated boundary.
- **Discriminated unions for variants and outcomes**:
  `type ToolOutput<T> = { kind: "ok"; value: T } | { kind: "error"; error: ToolError }`.
  `switch` over `kind` is exhaustive (default branch assigns to `never`).
- **One source per shape — derive, don't duplicate**: a DTO class is its own type; inside the
  framework `z.infer<typeof Schema>`, `typeof FlowState.State`, `ReturnType`, `Parameters`,
  `Pick` / `Omit`.
- **Immutable by default**: `readonly` fields and `ReadonlyArray` for data; `as const` for
  literal tables.
- **Compiler settings are the floor**: `strict` + `noUncheckedIndexedAccess`. No `any`, no
  non-null `!`, no `as` except at a validated boundary (parsing / branding). Exported functions
  have explicit return types.
- **Data crossing a tool or MCP boundary are DTO classes** (`agboss/dto`): one field
  decorator per field, plain data, validated by the framework at the boundary (tool arguments and
  results, MCP server tools, workflow start input). Workflows never write zod.
- External input the framework parses itself (CLI, config, settings, model JSON output) is
  validated with **zod inside the framework**; inside the system, types are trusted.
- Errors: throw typed `Error` subclasses with context; never swallow. No `console.log` in `src/`.

## Agents (LangGraph)

- **The workflow file is the graph.** `@Workflow({ flow: [...] })` is a list of paths —
  `start(…)` / `agent(…)` / `router(…)` / `action(…)` with `.returns`, `.toAgent` / `.toRouter` /
  `.toAction` / `.toFinish`, `.chooseOne(route(…)…)`, `.switch(caseOf(…)…)` and `.onError(…)`
  (CLAUDE.md → The flow: paths); nodes are `@WorkflowStart`, `@Router`, `@Agent`, `@Action`,
  `@WorkflowFinish`. Each node reads its `input` from the path's scope; `.agboss/types.d.ts`
  (`agboss check`) types it.
  Assembly rules run at assembly, before any model call, and report **all** violations at once
  (`GraphRuleError` with stable codes). A new rule gets a code and a test.
- **Config-driven.** Agents, models, thinking and caching live in the workflow's components
  (`@Agent`, `@Router`, `@Workflow`), assembled into the config and validated at startup; steps
  live in `@Workflow({ maxSteps })` and money in the application's `@Budget`s, not in config.
  Every chat model inherits `defaults.chat`; each router names its own `model` or takes
  `defaults.router.model`; guards take `defaults.guardrail.model` (Jev), never the router's —
  `defaults` cascade application → workflow → component (#261). Model choice is config, never code. Reference: Wiki → Configuration.
- **`MODEL_MAX` is the only way to say "no output cap"** — never a magic large number.
- **Models come from model providers** (`@ModelProvider`, `agboss/models`, #151): application
  infrastructure, listed only in `@Application({ providers })` (#266; none → the built-in OpenRouter
  - Decisions providers, one listed → the list is complete); each model of the application is
    served by exactly one listed provider (`serves`) — `[model.unserved]` /
    `[model.ambiguous-provider]` at assembly, a workflow never picks one; reasoning and caching are the
    provider's, a component may override them (`thinking`, `cache` until #152). Cache markers and
    every other provider-specific request field are set in one place, the provider's wire form
    (`toWireRequest`) — no provider-specific request code outside `src/models` / `src/llm`.
- **Settings must fit their models**: checked against the provider's capabilities at startup and
  by `agboss check --models` (in `make check`), all problems at once; nothing is silently substituted.
- **Prompts are checked at assembly** (#199): every agent, router and route prompt is read
  (`promptUrls` eagerly) and its `{{variables}}` checked against `promptVariables` —
  `[prompt.unknown-variable] file:line …`, `[prompt.missing-file]`, all at once, also by
  `agboss check`; what a node reads comes in its input message, never as `{{input.…}}`
  (`[prompt.input-in-instructions]`). `promptVersion` hashes the rendered texts, never file paths.
- **Routers are isolated** (`src/routers`): input is plain text + options, output is a
  `RouteOutcome` union (`decided` | `failed`); they import only `config`, `finops`, `llm`, and the
  rest of the code imports them only via `src/routers/index.ts` — ESLint-enforced. Routers are
  tested on their own (`packages/agboss/tests/routers/`), the graph adapter separately.
- **`@Router` = how + what.** `decidedBy` says who chooses: a model router's `prompt` /
  `promptUrls` say how, its `routes` what each choice means (`{ prompt, target }`, the text
  required); a code router's `route(input)` (`implements RouterHandler<Self>`) decides by types,
  never by matching text. `.chooseOne(route(…)…)` in the flow lists exactly those targets
  (`[router.routes-mismatch]`). A route
  **to a workflow finish** is worded as a stop instruction ("Stop and send the answer: …") — worded as
  "the answer is ready", Jev kept sending the turn back to the last agent (#116).
- **A router failure fails the run** unless an `.onError(…)` right after it takes it (#280 S19):
  `RouterFailedError` (`step.router` — its model call or its `route()` failed, the cause kept) or
  `RouterDecisionError` (`step.router.invalid-decision` — an answer outside its routes, never
  retried). No guessing, no fallback route; its spend is kept.
- **Classification is not generation**: routing, guards and detection use a decision model
  (Jev) — calibrated probabilities over fixed options; chat models produce content.
- State is declared once (`src/flow/runtime/state.ts`, `Annotation.Root`; the path's scope in its
  own channel). Nodes are typed with
  `SyncNode` / `AsyncNode<TState, TUpdate>` and return only the keys they own.
- Models are created only behind `ModelGateway` (the registry asks it; the default gateway asks the
  model providers) and injected; tests inject scripted models or fakes through the same gateway.
- Prompts live in `src/prompts/` (agents, graph) and `src/routers/prompts.ts` (routers own their
  prompts to stay isolated). No prompt strings inside nodes.
- Tools: `input` / `output` DTO classes (`*.dto.ts`), tested standalone (`toolOf(new Tool(fakes))`)
  before being wired into a graph. Agents run the framework's own loop (`src/graph/agent-loop/`) —
  no `createAgent`, no middlewares; side-effecting tools pass
  `executionContext.step.idempotencyKey` (`deps: [ExecutionContext]`) to the external service.
- **Bound every loop**: a node's `maxVisits` (required on a node on a cycle —
  `graph.cycle-without-max-visits`), the run's steps limit (`@Workflow({ maxSteps })` — visits of
  agents and routers, default (agents + routers) × 3), and LangGraph `recursionLimit` only as a
  safety net far above the steps.

## FinOps

- **Every LLM call is accounted.** Each node that calls a model appends a `UsageRecord`
  (caller, model, tokens, USD) via `recordUsage`. An untracked model call is a defect.
- **Prefer reported cost over estimates**: a provider with `ModelCost.fromResponse()` (OpenRouter,
  Jev) reports each call's exact cost (`costSource: "api"`); otherwise tokens × its price table
  (`ModelCost.fromPrices`, `costSource: "price-table"`). A call with neither fails.
- **Money limits are `@Budget` components** (#261), every one listed in
  `@Application({ budgets })` and written in `config/budget.config.ts`: `@Budget({ name, scope,
period?, workflow?, deps? })` + `implements BudgetHandler` (`maxSpend(): Usd | Promise<Usd>`, no
  parameters — the data come through the constructor: `ExecutionContext`, the project's tenant
  context, a billing service; never the request body). `BudgetScope.Execution` — one full pass of
  `app.execute`, a workflow's own (`workflow: X`) or the default; `BudgetScope.Tenant` /
  `Application` — per `BudgetPeriod.Day | Week | Month` (UTC). Assembly requires an execution budget
  for every workflow (own or the default), a tenant and an application budget, and no duplicates
  (`[budget.*-required]`, `[budget.duplicate-…]`). Steps are `@Workflow({ maxSteps })`, visits each
  node's `maxVisits` — counts, never money.
  - `maxSpend()` is read **once per execution**, at its start (in its frame: an injected
    `ExecutionContext` reads it), and kept in its state for the whole execution — a resume and a
    recovery count against the same amounts; the ledger keeps the last one read.
  - The ledger (`CostLedgerRepository`: listed in `@Application({ providers })`, else the built-in
    in-memory one — nothing in the home folder) keeps one counter per budget, scope key (the
    application's name, the `tenantId`, the execution's id) and period; every call's cost is added
    to all of the execution's counters while it streams, so a crashed execution's spend still counts.
  - Before the first step every budget is checked: one exhausted **rejects** the execution
    (`BudgetExceededError`, an `onRunRejected`; no thread, no record, no call — a refused request leaves no trace). Before every working step the
    counters are read again (the tenant's other executions count) and every budget is checked;
    before every model call too. The first exhausted **fails the execution** — never a quiet stop,
    unless the path's `.onError(BudgetExceededError, …)` takes it — with `budget`, `scope`, `key`,
    `maxSpend`, `spent` and a sentence (`tenant acme spent $40.05 today; tenant-daily-budget allows
$40`). Limit errors are one class per limit, all `LimitExceededError`s: `StepsLimitExceededError`
    (`workflow`, `maxSteps`, `steps`), `VisitsLimitExceededError`, `BudgetExceededError`.
  - **Nothing is reserved**: a budget protects from draining money, it is not exact accounting —
    parallel executions of one tenant may overrun it a little, and a budget may be exceeded by the
    cost of one call (a call in flight cannot be stopped; with `MODEL_MAX` one call is bounded only
    by the model). A branch of a parallel launch counts the spend at the launch plus its siblings that
    already ended (#273).
  - `maxSteps` is checked at assembly: `[limits.max-steps-too-low]` (no finish fits in a hand-set
    `maxSteps`, or the default (agents + routers) × 3 cannot hold the worst case of a per-item
    launch — set `maxSteps`), `[limits.branch-exceeds-max-steps]`, `[limits.max-steps-unused]`.
  - A provider's fallback (`circuitBreakerPolicy.fallback`) maps each used model to its own
    (`fallbackModels`, checked at startup: `model.fallback-unmapped` / `model.fallback-no-price`);
    a fallback call is sent and recorded as that model, at the fallback's prices.
- **Caching is accounted**: cached input is priced at `cacheReadPerMTok` / `cacheWritePerMTok`
  (fallback: input price); `CostReport.cacheReadTokens` shows how much caching saved.
- **Right-size models**: the cheapest capable model for routing/classification; expensive
  models only for agents that need them; thinking only where it pays off.
- **Every run returns a `CostReport`** (total, calls, per caller); the CLI prints it. New
  cost-relevant behaviour gets a test asserting the accounting.
- **$0 test suite**: unit tests use fake models; real calls only in `make smoke`.
- Per-call inspection (latency, tokens, prompts): LangSmith tracing via env, no code changes.

## Tests

- **Coverage ≥ 80%** lines / branches / functions / statements (enforced).
- Tests never hit a real LLM or network. The whole application: `testWith(Application)` from
  `agboss/testing` (scripted models, stubbed MCP servers, blocked network, matchers by class);
  units: `FakeListChatModel` / `FakeStreamingChatModel` from `@langchain/core/utils/testing`.
- Compile-time tests: `// @ts-expect-error — <reason>` lines in a `*.test.ts`, checked by `tsc`.
- Real-model checks go to `tests/smoke/` and run only via `make smoke`.
- Each spec test case → one test. Name tests by behaviour:
  `it("returns a fallback answer when the model output is empty")`.
- Arrange / Act / Assert, one behaviour per test, no logic in tests.
- Required per ticket: happy path, edge cases from the spec, regression for touched behaviour.

## Self-review checklist (before PR)

- [ ] Diff contains only what the issue asks for
- [ ] No file over 200 lines, no function over 50
- [ ] No duplicated logic introduced
- [ ] Every new concept has a named type; no anonymous object types in exported signatures
- [ ] Reusable code is generic, not duplicated per type; confusable primitives are branded
- [ ] Tool and MCP data are DTOs; external input the framework parses is validated
- [ ] No prompt strings in nodes, no real LLM in tests
- [ ] Every new model call records usage; new agents have a price and a prompt
- [ ] Names are intention-revealing; no dead code, no commented-out code
- [ ] Every spec test case has a matching test
