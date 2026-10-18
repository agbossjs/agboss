# FinOps

## Measure

- **Every model call is accounted**: a `UsageRecord` (caller, model, input/output/cache tokens,
  USD, `costSource`) per call, accumulated in graph state.
- **Cost source** — the call's [model provider](Model-providers#cost): a cost the provider reports
  in its answer (Jev, OpenRouter's `usage.cost`) is exact (`"api"`) and always comes first; else the
  provider's price table (`ModelCost.fromPrices`) or the component's own `price` (`"price-table"`):
  uncached input × input price + cache read/write × cache prices (fallback: input price) + output ×
  output price. A call with neither fails — never silently free.
- **Tool costs**: what a tool spends on models through the framework is recorded as the tool's —
  `tool:<name>` — in the same loop as the agent's model calls, so it counts in the run budget check
  before the next model call, in the daily ledger and in a failed agent's spend. A decision a
  tool's service makes through `ROUTER_FACTORY` during the call (job-scout's fit judge) is accounted
  this way, with the decision's model and exact cost; a knowledge-base search reports its retrieval
  cost under `rag:<name>` (`costSource: "tool"`).
- **Services that are not models** (#280 S43): a `@Tool` or an `@Action` takes `SpendRecorder` in
  its `deps` and records what one call of the service cost —
  `this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) })`. The record (`model`: the
  service, `costSource: "tool"`) joins the current tool call's spend (`tool:<name>`) or the step's
  (`action:<name>`, category `tools`), so it counts in `perRun.cost` / `perDay.cost` — the next
  check (before the agent's next model call, or the next agent or router visit) fails the run with
  `BudgetExceededError` — and in the daily ledger and the run's `spend`. Called outside a step or a
  tool call (a constructor, a timer after the call ended) it throws `SpendOutsideStepError`
  (`[spend.outside-step]`). `ExecutionContext` stays read-only: spend never goes through it.

<!-- snippet-context
import { Text } from "agboss/dto";
export class WebQueryDto {
  @Text({ prompt: "what to search the web for" }) query!: string;
}
export class WebResultsDto {
  @Text() text!: string;
}
-->

```ts
import { SpendRecorder, Tool, type ToolHandler } from "agboss";
import { usd } from "agboss/units";

@Tool({
  name: "web_search",
  description: "Searches the web (a paid API)",
  input: WebQueryDto,
  output: WebResultsDto,
  deps: [SpendRecorder],
})
export class WebSearchTool implements ToolHandler<WebQueryDto, WebResultsDto> {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  run({ query }: WebQueryDto): Promise<WebResultsDto> {
    this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) }); // tool:web_search
    return Promise.resolve({ text: `results for ${query}` });
  }
}
```

A decision made through `ROUTER_FACTORY` needs no recording — the framework accounts it:

<!-- snippet-context
import { Text } from "agboss/dto";
export class RateQuery {
  @Text({ prompt: "currency pair, e.g. USD/ILS" }) pair!: string;
}
export class Rate {
  @Text() rate!: string;
}
-->

```ts
import { ROUTER_FACTORY, Tool, type RouterEngine, type ToolHandler } from "agboss";

@Tool({
  name: "exchange_rate",
  description: "Today's rate, checked by a cheap decision model",
  input: RateQuery,
  output: Rate,
  deps: [ROUTER_FACTORY],
})
export class ExchangeRate implements ToolHandler<RateQuery, Rate> {
  private readonly checker: RouterEngine;

  constructor(routers: (name: string) => RouterEngine) {
    this.checker = routers("rate-check");
  }

  async run({ pair }: RateQuery): Promise<Rate> {
    // the decision's spend is recorded as tool:exchange_rate
    await this.checker.route({
      input: `${pair} 3.71`,
      options: [
        { name: "plausible", description: "the rate is within a day's range" },
        { name: "suspicious", description: "it is not" },
      ],
    });
    return { rate: `${pair} 3.71` };
  }
}
```

- **Report**: every run returns `CostReport` (total, calls, cache-read tokens, per caller) and the
  budget it was allowed; the CLI prints it. Per-call traces: [Tracing](Tracing).

## Budgets

Money limits are `@Budget` components (#261): one template for every budget — the decorator says
what it limits, `maxSpend()` how much, its data through the constructor like any component's. Every
budget of the application is listed in `@Application({ budgets })`, written in
`config/budget.config.ts`; `name` ends with `-budget`, the class with `Budget`.

```ts
// config/budget.config.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";

@Budget({
  name: "application-daily-budget",
  scope: BudgetScope.Application, // the whole application per period
  period: BudgetPeriod.Day, // UTC: Day | Week | Month
})
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(20);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5); // per organization; its own amount comes from tenant data (#261 PR 3)
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution }) // no workflow: the default
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1); // one full pass of app.execute, children included
  }
}
```

- The options are a union discriminated by `scope`: `period` is required for `Tenant` /
  `Application` and does not compile on `Execution`; `workflow: X` (a workflow's own execution
  budget) only on `Execution` — without it, the default execution budget of every workflow without
  its own.
- A budget is a component: injectable (`deps: [ApplicationDailyBudget]`), created at start with the
  application, replaced in a test with `mockOf(TenantDailyBudget).maxSpend.mockReturnValue(usd(0.01))`.
- **This release declares them.** The checks — `maxSpend()` read once per execution, every budget
  checked before the first step and counted after every model call (`BudgetExceededError`), and the
  `[budget.*-required]` rules — come with #261 PR 5; until then the money is capped by the
  workflow's `settings().limits` below.

## Limit — per workflow

Money limits come from the workflow's `settings()`, steps and visits from its components ([Workflow](Workflow)):

| Limit                    | Boundary key               | Meaning                                                          |
| ------------------------ | --------------------------- | ------------------------------------------------------------------ |
| `perRun.cost`            | `limits.perRun.cost`       | USD one run may spend                                            |
| `perDay.cost`            | `limits.perDay.cost`       | USD the workflow may spend per **UTC** day — resets at 00:00 UTC |
| `@Workflow({ maxSteps })` | `maxSteps`                | agent and router visits per run (default (agents + routers) × 3) |
| `maxVisits` on `@Router` / `@Agent` | `<name>.maxVisits` | visits of one node per run (`VisitsLimitExceededError`)    |

- **Ledger**: the application's `CostLedgerRepository` (#261) — the spend per workflow per UTC
  day; a new day is a new counter, which is the reset. Listed in `@Application({ providers })`
  (a class that `extends CostLedgerRepository`), else the built-in in-memory one: each instance
  counts on its own and the counters reset on restart — nothing is written to the home folder
  any more (the SQLite ledger comes with #265).
- **Before a run**: the day is read once; nothing left → `LimitExceededError` (`limits.perDay.cost`),
  no calls made. The run budget (`min(perRun.cost, perDay.cost − spent today)`) also stops an agent's
  loop before a model call it cannot afford.
- **During a run**: every model call is written to the ledger as the graph streams. Before each
  working node (agent, router) the limits are checked; crossing one **fails** the run with
  `LimitExceededError` (key, limit, actual, path, spend) — never a quiet stop — and the failed Tern
  carries the spend. A paid failure (an agent crossing `agents.<name>.limits.*`, a router that could not routeTo)
  carries its spend, which is written to the ledger before rethrowing — failures are paid for
  too. A paused run's spend is written at the pause.
- **Soft by one call**: a call in flight cannot be stopped; parallel runs of one workflow can overshoot
  the daily cap by their in-flight calls. `MODEL_MAX` makes a single call bounded only by the model.
- `npm run studio` runs the flow graph with the workflow's limits; the day's spend is read from the ledger.
- Optional extra backstop outside the app: a spending limit on the OpenRouter key itself.

## Turn financials — part of every result

Every `ExecutionOutput` carries `spend` (`CostReport`) — the core always reports it; each client
decides what to show:

| Field                                  | Meaning                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `totalUsd`, `calls`, `cacheReadTokens` | the turn in total                                                                               |
| `byCategory`                           | `agents`, `routing`, `guards`, `review`, `tools`, `compaction`, `retrieval` — every key present |
| `byModel`, `byCaller`                  | the same money by model and by caller                                                           |
| `trace`                                | every call in order: caller, category, model, cost, how it was priced, tokens                   |

Categories come from the caller: `tool:*` → tools, `compaction` → compaction, `rag:*` → retrieval, `router:guard:*` → guards, `router:quality:*` →
review, other `router:*` → routing, an agent name → agents. A resumed (paused) run reports the whole
run.

The CLI and the chat print it every turn:

```
thread 6cc2173e-… · http://localhost:3000/project/…/sessions/6cc2173e-…
researcher · stop: jev confidence 0.96
agents $0.002332 · routing $0.000038 · guards $0.000033 · tools $0.001000
   1. router:guard:prompt_injection  typesafe/jev-1.13  $0.000014  api-priced
   2. router:main                    typesafe/jev-1.13  $0.000016  api-priced
   3. researcher                     kimi-k2.6          $0.000426  306 in / 116 out
   5. tool:exchange_rate             exchange_rate      $0.001000  tool-reported
   …
total $0.003403 (8 calls)
```

`api-priced` = exact price from the provider (Jev bills per decision); `N in / M out` = tokens ×
price table; `tool-reported` = the tool's own cost.

## Eval spend

`npm run eval` / `npm run replay` / `compare` pay from `<workflow>:eval` — its own day, capped at the
workflow's `limits.perDay.cost` (no cap when unset); they never eat the production day. See [Terns and evaluation](Terns-and-evaluation).

## Tests

Unit tests use fakes and cost $0; real calls only in `make smoke`.
