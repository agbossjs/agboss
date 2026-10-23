---
name: agboss
description: How to write and change AGBoss applications (decorators, the flow DSL, DI, budgets, tests, CLI). Use on any task in this project that touches src/, tests/ or an agboss command.
---

<!-- agboss-skills-version: 0.1.0 — managed by `agboss check`; edits here are replaced -->

# AGBoss 0.1.0

AGBoss is a TypeScript framework over LangGraph: an **application** (`@Application`) lists its
**workflows** (`@Workflow`), each a list of **paths** through decorated components — starts,
agents, routers, actions, finishes — wired by a dependency-injection container, with budgets, tests
and a CLI. This file is always read first; it routes every task to one reference below. Read that
reference before writing code: the names here are the installed version's, and older names you may
remember (`thinking`, `timeoutMs`, `createApp(Workflow)`, `ctx`, zod schemas, `ToolFailedError`,
`@Guardrail`) do not exist.

## The 10 invariants

1. **The application is the unit.** `createApp(App)`, `testWith(App)` and every `npx agboss …`
   command take an `@Application`; a `@Workflow` runs only as one of its `workflows` (or as a child
   of one). `createApp(Workflow)` and `testWith(Workflow)` do not compile.
2. **One class per file, named by its kind.** Folders by kind (`agents/`, `tools/`, `routers/`,
   `actions/`, `workflow-starts/`, `workflow-finishes/`, `services/`, `guardrails/`, …), files
   `<name>.<kind>.ts`, a component's `name` in kebab-case ending with its kind (`billing-agent`,
   `refund-tool`, `desk-router`, `chat-workflow-start`, `desk-workflow`) — `[name.kind-suffix]`; the
   class is that name in PascalCase (`BillingAgent`, `DeskWorkflow`), and for an `@Application` and
   a `@Budget` the same rule checks the class name too (a `@Budget` class `DailyLimit` fails:
   `name it DailyLimitBudget`). A DTO class on a path ends with `Dto` (`[dto.name]`).
3. **The flow is paths, written one call per line.** `@Workflow({ flow: [start(S) … .toFinish(F)] })`;
   `.returns(XDto)` says what the step before put on the path (its scope), and a later node reads its
   `input` fields from that scope — as `{ producer, value }` records (`input.order.value`), never by
   position. Every path ends in a finish.
4. **Data are DTO classes, values are plain objects.** One field decorator per field (`@Text`,
   `@Integer`, `@Flag`, `@OneOf`, `@ListOf`, `@Nested`, …) from `agboss/dto`; a value is
   `{ orderId: "7" }`, never `new OrderDto()`. No zod, no JSON Schema by hand.
5. **Decorator = metadata, constructor = dependencies, methods = a contract.** `deps: [A, B]` lists
   the constructor's parameters in order (the compiler checks it); `implements ToolHandler<In, Out>`,
   `ActionHandler<Self>`, `RouterHandler<Self>`, `JudgeHandler<TReply>`, … The container creates
   every component — project code never calls `new` on one.
6. **Components keep no state.** Another instance may continue an execution after a pause: read the
   execution from an injected `ExecutionContext`, time from `Clock`, ids from `IdGenerator`; data
   that outlive a step go through the path (`.returns`) or your own service over external storage.
7. **Values carry units.** `seconds(30)`, `minutes(5)`, `hours(24)`, `usd(0.05)`, `kilobytes(256)`
   from `agboss/units` — `timeout: seconds(5)`, never `timeoutMs: 5000`.
8. **Infrastructure lives in the application only.** Stores (`Sqlite…Repository`), `Clock`,
   `IdGenerator`, `Logger`, model providers, channel implementations and observers are listed in
   `@Application({ providers | observers })`; a workflow's `providers` are its services
   (`[di.infrastructure-in-workflow]`). A contract gets the one listed class that `extends` it.
9. **Failures are typed and handled in the flow.** Every error is an `AGBossError` subclass with a
   stable `code`; `.onError(ErrorClass, side path)` right after a step catches that class, its
   subclasses and errors caused by it. A side path that can catch a `LimitExceededError` leads only
   to actions and finishes (`[graph.limit-handler-uses-model]`).
10. **The generated types are the contract — regenerate, never edit.** `npx agboss check` writes
    `.agboss/types.d.ts` (input of every node, `app.execute`, scripts in tests); after changing a
    decorator, a DTO or a path, run it before trusting a type error. Tests never call a real model.

## The loop after every change

```
npx agboss generate agent billing-agent --workflow desk-workflow   # scaffold + wire (also tool, router, …)
npx agboss check                                                   # assembly rules, types, prompts, environment
npx agboss describe                                                # the flow, models, limits as assembled
npm test                                                           # scripted models, no network
```

- `npx agboss generate <kind> <full name> --workflow <workflow's full name>` writes the files and
  the wiring (an agent's route, a tool in an agent's `tools`) and regenerates the types. Kinds:
  `workflow`, `agent`, `router`, `arbiter`, `tool`, `mcp`, `rag`, `openapi`. A name without its
  kind suffix is rejected, never completed.
- `npx agboss check` must print `ok:`; it reports **all** problems at once as `[rule.code]` lines —
  fix every one, then run it again. `npx agboss check --strict` makes the analyser's warnings
  errors; `npx agboss check --models` also checks the models against their providers.
- `npx agboss describe` is how you see the flow, each node's inputs and producers, each model and
  where its setting came from — read it instead of guessing what the decorators resolved to.
- The CLI finds the application through `"agboss": { "application": "src/<app>.application.ts" }`
  in `package.json`.

## Testing and evals: cheapest check first

- **Loop 0** (static, $0): `npx agboss check` and `npx agboss describe`. **Loop 1** (every commit,
  $0): the unit runners (`testTool`, `testJudge`, …) first, then `testWith(App)` with scripted models
  or a recorded cassette — reference 10. Assert the path, the finish and trajectory invariants
  through `result.toolCalls` (`ToolCallRecord`, `ToolCallStatus`, `toolCallsOf`): which tools ran,
  with what, how each ended — never the position of a step. `result.record.steps`
  (`{ record: true }`) has each visit's judge verdicts, guardrail decisions, spend and `inputHash`;
  a judge reads the visit's calls as `input.toolCalls`.
- **A stale cassette** (`StaleCassetteError`, `[vcr.stale-cassette]` — a component's prompt or
  schema changed since it was recorded; `npx agboss check --cassettes` finds it without a test):
  never edit the cassette by hand — re-record its stale interactions with
  `AGBOSS_VCR_MODE=RECORD_STALE npm test`, then run the evals.
- **Evals on a live model** are declared as an `@EvalSuite` (`agboss/eval`,
  `eval-suites/<name>.eval-suite.ts`): cases built with `evalCase`, `turn`, `pastTurn`, `toolCall`,
  `toolInvariant`, checks in a declared order with `EvalCascade` — free trajectory invariants
  (`checkTrajectory()`), then code judges (`@Judge({ decidedBy: DecidedBy.Code })`), then model
  judges. `npx agboss check` assembles them too (Loop 0).
- **Loops 2 and 3** (a live model, paid): `npx agboss eval run --suite <name> --runs <k> --report
<run.json>` — each case k times on the real application (`--env`), the cascade per run, pass@k and
  pass^k per case, the run artifact kept from `main` as the reference (`--html <file>` writes it as
  one self-contained page; `npx agboss eval show <run.json> --html <file>` renders a saved one,
  running nothing); `npx agboss eval score`
  scores recorded runs (the bare `npx agboss eval` lists both).
- A case that passes at least once in k runs but not every time (pass@k high, pass^k low — printed
  `unstable`): do not grow the prompt — propose deterministic code (a `@ToolInterceptor`, a code guardrail,
  `DecidedBy.Code` on a `@Router` / `@Arbiter`, an `@Action`).

## The gate's rules

AGBoss code follows these everywhere — the framework's own gate enforces them with lint
(`agboss/no-component-state`, `agboss/no-direct-time`, `@stylistic/newline-per-chained-call`) and a
suppression budget, and a project made by `npx agboss create` lints with the same rules (its
`eslint.config.js`). Never work around them:

- No `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error` outside compile-time tests,
  `eslint-disable` or `prettier-ignore`. A type error is fixed in the code or the decorator, or by
  regenerating the types (`npx agboss check`).
- No mutable state on a component: `this.x = …` outside the constructor (`agboss/no-component-state`).
- No `Date.now()`, `new Date()`, `setTimeout` in components: inject `Clock` (`clock.now()`,
  `clock.sleep(delay, signal)`) — tests run on a virtual clock.
- `*.workflow.ts` is formatted one call per line (`@stylistic/newline-per-chained-call`) — every
  method chain in it, the flow and any other (`WorkflowSettings.builder()` / `.onIncompatibleResume(…)`
  / `.build()`).
- Explicit return types on exported functions and methods; no `value!` non-null assertions (a DTO
  field's `orderId!: string` is a definite assignment and is required).
- Imports only from the public entries: `agboss`, `agboss/dto`, `agboss/units`, `agboss/models`,
  `agboss/testing` (+ `agboss/testing/setup`), `agboss/mcp`, `agboss/rag`, `agboss/a2a`,
  `agboss/memory`, `agboss/eval`, and `agboss/eslint` in `eslint.config.js` — never `agboss/internal`,
  `agboss/dist/…` or LangGraph directly.

<!-- snippet-context
import { Injectable } from "agboss";
import { Text } from "agboss/dto";
export class OrderQueryDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}
export class OrderStatusDto {
  @Text({ prompt: "where the order is" })
  status!: string;
}
@Injectable()
export class OrderBookService {
  statusOf(orderId: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`order ${orderId} shipped (${idempotencyKey})`);
  }
}
-->

```ts
// tools/order-status.tool.ts — the shape of every component: decorator, deps, a typed contract
import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { seconds } from "agboss/units";

@Tool({
  name: "order-status-tool",
  description: "The status of an order",
  input: OrderQueryDto,
  output: OrderStatusDto,
  timeout: seconds(10),
  deps: [ExecutionContext, OrderBookService],
})
export class OrderStatusTool implements ToolHandler<OrderQueryDto, OrderStatusDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly orderBookService: OrderBookService,
  ) {}

  async run({ orderId }: OrderQueryDto): Promise<OrderStatusDto> {
    const key: string = this.executionContext.step.idempotencyKey; // one key per call, stable on retry
    return { status: await this.orderBookService.statusOf(orderId, key) };
  }
}
```

## Where to read next

| Task                                                                                                                                                                                                                                  | Read                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Designing a workflow: which primitive, how to split it, its DTOs, files and images                                                                                                                                                    | `references/01-composition-and-architecture.md`   |
| Writing `*.workflow.ts` paths: branches, loops, parallel launches, quorums, `.onError`                                                                                                                                                | `references/02-flow-dsl-all-combinations.md`      |
| A component class: decorators, DI, lifecycle hooks, contexts, environments, `app.*`, a `@ToolInterceptor` around tool calls                                                                                                           | `references/03-components-di-and-lifecycle.md`    |
| Connecting MCP servers, exposing a workflow over MCP, calling or serving A2A agents                                                                                                                                                   | `references/04-mcp-and-a2a.md`                    |
| Human approvals, pauses, channels, `app.resume`                                                                                                                                                                                       | `references/05-channels-and-human-in-the-loop.md` |
| Budgets, model providers, retries, rate limits, circuit breakers                                                                                                                                                                      | `references/06-finops-providers-and-queues.md`    |
| Input / output guardrails, PII masking                                                                                                                                                                                                | `references/07-guardrails-pii-and-security.md`    |
| Execution records, observers, Langfuse / OpenTelemetry traces                                                                                                                                                                         | `references/08-observability-and-tracing.md`      |
| SQLite stores, recovery, graceful shutdown, health probes, rolling deploys                                                                                                                                                            | `references/09-persistence-k8s-and-deploy.md`     |
| Tests: `testWith`, unit runners (`testTool`, `testAction`, `testRouter`, `testArbiter`, `testRag`, `testJudge`, `testGuardrail`, `testToolInterceptor`, `testPii`, `testCompaction`), races, VCR cassettes, `@EvalSuite`, code judges | `references/10-testing-vcr-and-evals.md`          |
| A CLI command, LangGraph Studio, a `[rule.code]` error                                                                                                                                                                                | `references/11-cli-studio-and-error-catalog.md`   |
| A whole feature or application from scratch                                                                                                                                                                                           | `references/12-end-to-end-recipes.md`             |

Put this project's own rules in the root `AGENTS.md`, never in this folder: `npx agboss check`
replaces it on every `agboss` upgrade.
