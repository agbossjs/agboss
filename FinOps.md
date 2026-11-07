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
  `tool:<name>` — in the same loop as the agent's model calls, so it counts in the budget check
  before the next model call, in the budgets' counters and in a failed agent's spend. A decision a
  tool's service makes through `ROUTER_FACTORY` during the call (job-scout's fit judge) is accounted
  this way, with the decision's model and exact cost; a knowledge-base search reports its retrieval
  cost under `rag:<name>` (`costSource: "tool"`).
- **Services that are not models** (#280 S43): a `@Tool` or an `@Action` takes `SpendRecorder` in
  its `deps` and records what one call of the service cost —
  `this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) })`. The record (`model`: the
  service, `costSource: "tool"`) joins the current tool call's spend (`tool:<name>`) or the step's
  (`action:<name>`, category `tools`), so it counts in every budget of the execution — the next
  check (before the agent's next model call, or the next step — an action too, #634) stops it with
  `BudgetExceededError` — and in the run's `spend`. Called outside a step or a
  tool call (a constructor, a timer after the call ended) it throws `SpendOutsideStepError`
  (`[spend.outside-step]`). `ExecutionContext` stays read-only: spend never goes through it.

<!-- snippet-context
import { Text } from "@agboss/core/dto";
export class WebQueryDto {
  @Text({ prompt: "what to search the web for" }) query!: string;
}
export class WebResultsDto {
  @Text() text!: string;
}
-->

```ts
import { SpendRecorder, Tool, type ToolHandler } from "@agboss/core";
import { usd } from "@agboss/core/units";

@Tool({
  name: "web-search-tool",
  description: "Searches the web (a paid API)",
  input: WebQueryDto,
  output: WebResultsDto,
  deps: [SpendRecorder],
})
export class WebSearchTool implements ToolHandler<WebQueryDto, WebResultsDto> {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  run({ query }: WebQueryDto): Promise<WebResultsDto> {
    this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) }); // tool:web-search-tool
    return Promise.resolve({ text: `results for ${query}` });
  }
}
```

A decision made through `ROUTER_FACTORY` needs no recording — the framework accounts it:

<!-- snippet-context
import { Text } from "@agboss/core/dto";
export class RateQuery {
  @Text({ prompt: "currency pair, e.g. USD/ILS" }) pair!: string;
}
export class Rate {
  @Text() rate!: string;
}
-->

```ts
import { ROUTER_FACTORY, Tool, type RouterEngine, type ToolHandler } from "@agboss/core";

@Tool({
  name: "exchange-rate-tool",
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
    // the decision's spend is recorded as tool:exchange-rate-tool
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

- **Report**: every run returns `CostReport` (total, calls, cache-read tokens, per caller) and what
  it was allowed to spend (the least its budgets had left at its start); the CLI prints it. Per-call traces: [Tracing](Tracing).

## Budgets

Money limits are `@Budget` components (#261): one template for every budget — the decorator says
what it limits, `maxSpend()` how much, its data through the constructor like any component's. Every
budget of the application is listed in `@Application({ budgets })`, written in
`config/budget.config.ts`; `name` ends with `-budget`, the class with `Budget`.

```ts
// config/budget.config.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

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
- **Who reads what**: a budget's data come through its constructor — the injected
  `ExecutionContext` (the execution, its step, `executionContext.tenant`), the project's tenant
  context (`deps: [ShopTenantContext]`, its own amount from server-side tenant data) or a service
  such as `BillingService` — a trusted source, never the request body.

<!-- snippet-context
import { Budget, BudgetPeriod, BudgetScope, TenantContext, Workflow, WorkflowFinish, WorkflowStart, start, type BudgetHandler } from "@agboss/core";
import { Decimal, WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
export class ShopTenantContext extends TenantContext {
  @Decimal()
  dailyBudgetUsd!: number;
}
@WorkflowStart({ name: "screening-workflow-start", description: "A role", input: WorkflowStartTextDto })
export class ScreeningWorkflowStart {}
@WorkflowFinish({ name: "screening-workflow-finish", description: "The role as given", output: WorkflowStartTextDto })
export class ScreeningWorkflowFinish {}
@Workflow({
  name: "screening-workflow",
  version: "1.0.0",
  flow: [
    start(ScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ScreeningWorkflowFinish),
  ],
})
export class ScreeningWorkflow {}
-->

```ts
// config/budget.config.ts — the tenant's own daily amount, from its context (its fields: Context-And-Authorization)
@Budget({
  name: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  deps: [ShopTenantContext],
})
export class ShopTenantDailyBudget implements BudgetHandler {
  constructor(private readonly shopTenantContext: ShopTenantContext) {}

  maxSpend(): Usd {
    return usd(this.shopTenantContext.dailyBudgetUsd);
  }
}

@Budget({
  name: "screening-execution-budget",
  scope: BudgetScope.Execution,
  workflow: ScreeningWorkflow, // its own: replaces the default for executions of this workflow
})
export class ScreeningExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.5);
  }
}
```

### Assembly

Every workflow of the application is covered by its own execution budget or by the one default, and
there is at least one tenant budget and one application budget — so no execution runs without a cap
on its cost, its tenant's and the application's. All violations at once, before any model call:

| Code | When |
| --- | --- |
| `[budget.execution-budget-required]` | a workflow with no own execution budget and no default — `screening-workflow has no execution budget and there is no default — add one with workflow: ScreeningWorkflow or one without workflow` |
| `[budget.duplicate-execution-budget]` | two own execution budgets for one workflow |
| `[budget.duplicate-default-execution-budget]` | two execution budgets without `workflow` |
| `[budget.tenant-budget-required]` | no `BudgetScope.Tenant` budget (a single-tenant application has its one tenant, `"default"`) |
| `[budget.application-budget-required]` | no `BudgetScope.Application` budget |
| `[budget.not-a-budget]` | a class in `budgets` without `@Budget` |

### At run time

- **`maxSpend()` once per execution**, at its start — in the frame of its start step, so an injected
  `ExecutionContext` reads the execution (its `tenant`, its own fields, `step.nodeId` is the start's)
  — and kept in the execution's state for the whole execution: a resume (also after a restart) and
  a recovery count against the same amounts; a plan change applies from the next execution. The
  framework never calls `maxSpend()` outside an execution.
- **Which budgets**: the execution budget of the started workflow (its own, else the default),
  every tenant budget (keyed by the execution's `tenantId`) and every application budget (keyed by
  the application's name). Several budgets of one scope with different periods work at once
  (tenant daily + tenant monthly).
- **Exhausted** means the counter has reached the limit, compared in whole micro-dollars (USD ×
  10⁶, rounded, #728). A sum of float costs lands a hair off its decimal value (eight $0.10 calls
  make 0.7999999999999999), and a plain `>=` would let one more step through a limit the spend
  reached exactly. There is no epsilon: a spend a micro-dollar under the limit still passes.
- **Before the first step** every budget is checked against its counter in the current period:
  one exhausted **rejects** the execution — `BudgetExceededError`, an `onExecutionRejected` (code
  `limit.budget`) — and the refused request leaves no trace: no thread (a new thread is created only
  once the budgets pass; `executionContext.threadId` read in `maxSpend()` of an execution on a new
  thread throws `ExecutionContextUnavailableError`), no record, no checkpoint, no model call, and
  the amounts it read are not kept as the last known limit.
- **During the execution** every model call's (and paid service's) real cost is counted the moment
  it is made — a live tally of the tree's pass on this instance (#338) — and **written to all of its
  counters at once** (#727, #732): a step of the same tree on another instance — a child on any
  instance, its sibling, the parent of one — sees it at its next read of the counters, not at the
  end of the superstep that spent it. The execution's state keeps the record marked as in the
  ledger, with its id (`ledgerId`), so no later pass writes it again: the pass writes a checkpoint
  only once every spend it tallied before is in the ledger, and queues a child on any instance only
  then — also once the spend a sibling branch tallied after the launching step's own checkpoint is
  written (#776) —, so a takeover or a recovery that finds a marked record finds it counted. What is not tallied
  (a router's decision) is written when its step ends. A read of the counters never overlaps a
  write of the same pass, and a child on any instance has its spend taken in by its parent's pass
  with a read of the counters before the parent's state shows it: every dollar counts once,
  whatever the placement (#685). Each such spend is an **entry** of the ledger under its
  `ledgerId` — an id of the pass that made it, never derived from where it was made —, and the
  ledger adds an entry once: a write retried after its answer was lost counts once — in the pass's
  own checks too, which read the counters only once such a write is retried (#770) —, and so does a
  record an earlier pass kept that reaches a later one from a durable state (a takeover's restored
  writes, an agent's loop continued from its checkpoint). Entries are not kept for ever (#771):
  each is dated by its record's `madeAt`, and the recovery sweep prunes those made longer ago than
  `@Application({ retention: { costLedgerEntries } })` (default `hours(24)`) — see
  [Pruning the entries](#pruning-the-entries-771). A step **run again** after a crash or a
  takeover makes its spend again — its model calls are billed again, its services paid again — and
  that counts again, under the later pass's ids: the budget errs high, never low. A service you pay
  through a deduplicated call (`OutboundCalls` replaying an earlier answer) should record its cost
  with `SpendRecorder` only when the call was sent. Before every step that can spend or reach out
  the counters are read again — the tenant's other executions count, on any instance, through the
  ledger — and every budget (and the execution's deadline) is checked; before every model call of
  an agent's loop too. The first exhausted **stops** the execution with `BudgetExceededError`
  before that step runs (into the step's `.onError(BudgetExceededError, …)` if it has one, else the
  execution fails and its open undos run; the spend so far is in the ledger and the failed record).
- **Which steps are held back** (#634): every one that can spend or have an effect — an agent, a
  router (a code one too), an action, a child workflow (`.toWorkflow`, one per item, an
  `AnyInstance` one), a level of a recursion, each branch of a launch (`.toParallelAgents`,
  `.toParallelActions`, `.toParallelWorkflows`, a quorum's), the action of a side path an error of
  the step took. An action that pays past the budget is followed by nothing paid: a chain of paid
  actions stops at the first one after the budget ran out. Never held back:

  | Step | Why it runs |
  | --- | --- |
  | a start, a finish | it spends nothing: an execution whose last action overspends ends at its finish, its spend counted |
  | an undo (`compensateWith`) | it gives money back: a failure for the budget runs the open undos ([Rollback](Rollback)), with no budget check — and so does the undo action a side path runs to close an entry that was open when the side path was entered (`.onError(DeclinedError, toAction(RefundAction)…)`) |
  | an action of the side path that took a limit (`.onError(BudgetExceededError, toAction(NotifyAction)…)`, `.onJoinError(…)`), and the actions it leads to step by step | it is the application's reaction to the limit — that path reaches only actions and finishes (`[graph.limit-handler-uses-model]`); what it spends still counts |

  Both exemptions hold **only on that side path** (#656): it is the visit the `.onError` /
  `.onJoinError` leads to and, one visit after another, the visit each leads to — a record in the
  execution's checkpointed state, so the visit run again after a resume or a takeover reads it as
  the first run did. A finish or a launch ends it: the branches a side path launches, and whatever
  follows their join, are held back. An undo action reached any other way — a step of the main path
  that is also some entry's undo, or the undo of an entry opened on the side path itself — is a
  step like any other: held back. Without a side path for the budget's error the execution fails
  and its automatic undo undoes the entry; with one (`.toAction(RefundAction).onError(BudgetExceededError, …)`)
  the step stays held back, and the entry it would have closed is undone at once **as an undo**
  (#675) — the money goes back: the undo action in its own frame and key (`<step key>:compensation`),
  with no budget check, marked done in the tree's store like the automatic undo (a holder that
  takes the tree over and runs the visit again finds it undone), then the side path goes on. Its
  record is `CompensationReason.SidePath`, `Compensated` — `Failed` only with the undo's own error,
  never because the budget is exhausted.

- **A call that exhausts a budget** runs none of the tools its move asks for: the agent fails with
  `BudgetExceededError`, the call's cost in its spend. An answer it gave is kept — the next step or
  call stops.
- **A parallel launch** (#273, #338): a branch is checked against the larger of what its state holds
  (the spend at the launch plus its siblings that already ended) and the live tally — so it sees
  its siblings' calls while they run. The call whose tally exhausts a budget **aborts the calls in
  flight** of every branch of the tree's launches through `executionContext.signal`: a sibling's
  model call is cancelled (its partial cost is unknown and not recorded), a tool waiting on the
  signal stops, and the sibling's loop fails at its next check with `BudgetExceededError` and its
  spend so far. The branches fail with that error and the launch with it — the same for
  `.toParallelAgents`, `.toParallelActions` (the action's `executionContext.signal`),
  `.toParallelWorkflows` (the children's model and tool calls) and quorums — into
  `.onJoinError(BudgetExceededError, toAction(…)… | toFinish(…))`, a side path without a model
  (`[graph.limit-handler-uses-model]`), else the execution fails. A branch that started after the
  budget was exhausted is not aborted: it stops at its own check before it runs — an action's branch
  too (#634), so a branch listed after the one that spent the last of the budget never runs.

```ts no-check: a fragment of a flow
start(ReviewWorkflowStart)
  .returns(DraftDto)
  .toParallelAgents(StyleAgent, FactsAgent, LegalAgent)
  .join()
  .onJoinError(
    BudgetExceededError, // a branch's call exhausted a budget: the others were stopped at once
    toAction(NotifyEditorAction)
      .toFinish(ReviewStoppedWorkflowFinish),
  )
  .returns(listOf(ReviewNoteDto))
  .toAgent(SummaryAgent)
  .returns(ReviewDto)
  .toFinish(ReviewWorkflowFinish)
```

- **Nothing is reserved**: a budget protects from draining money, it is not exact accounting —
  parallel executions of one tenant may overrun it a little (each sees the others' calls once they
  are in the ledger — one write after they were made — and its counters read). A budget is
  exceeded by at most (#664, #727):

  | What | How much | Why no check bounds it |
  | --- | --- | --- |
  | the calls in flight when it was exhausted | what they cost | a step that passed its check before the spend that exhausted it runs to its end; a step that checks after it never runs |
  | the steps it never holds back (above, "Which steps are held back") | everything they spend | an undo gives money back, automatic or a side path's (a held-back undo's too, #675); the actions of the side path that took a limit are the application's reaction, step by step — `.onError(BudgetExceededError, toAction(NotifyAction).toAction(ArchiveAction)…)` overruns by what `NotifyAction` and `ArchiveAction` cost, however much that is |
  | across instances, per step and instance: the steps that read the counters before that spend was in the ledger | what those steps spend | a spend is in the ledger one write after it was made (#727, #732) — for another trees' steps and for the tree's own steps on another instance alike; a step on another instance that read the counters before that write landed, or checks only before its next step, runs as a call in flight does. An action that records a large spend and then works on no longer leaves the other steps passing their checks while it works: the one in flight at that moment is the bound, never the steps started after it |

  Nothing is reserved because a step's cost is known
  only after it (a call is not pre-checked by its `maxTokens`; `TokenLimit.MODEL_MAX` makes one call
  bounded only by the model; an action's service reports what it charged) — reserving money for
  parallel executions was rejected (#261, S76 f).

```text
BudgetExceededError {
  code: "limit.budget",
  message: "tenant acme spent $40.05 today; tenant-daily-budget allows $40",
  budget: { name: "tenant-daily-budget" }, // ComponentRecord: nameOf(TenantDailyBudget)
  scope: BudgetScope.Tenant,
  key: "acme",                             // the application's name, the tenantId, or the execution's id
  maxSpend: 40,
  spent: 40.05,
}
```

- **An automatic undo is never refused** (#340): the undo actions a failed join runs for its
  finished branches ([Rollback](Rollback#a-failed-join-undoes-its-finished-branches)) and those of
  an execution that ends without a finish — an exhausted budget among the reasons
  ([Rollback](Rollback#an-execution-that-ends-without-a-finish)) — take no budget check, so an
  exhausted budget never leaves a booking in place. What their services cost (`SpendRecorder`) is
  spend under `action:<undo name>`: in the join's update when its `.onJoinError` takes the failure;
  otherwise — the join fails the execution, a child or a root ends without a finish, a late undo
  — written to the ledger's counters at once, since no state of the execution will hold it (#340
  PR 3). A child's undo spend is then in the ledger only, not in its parent's `result.spend`.

### The ledger

The application's `CostLedgerRepository` (#261 S28) keeps one counter per budget, scope key and
period — `findSpentByCounter({ budget, scope, key, period })`, `saveAll(counters, records)` (each
call's cost added to every counter, atomically per counter; a record with a `ledgerId` is an entry
added once, #727 — a repeated or racing save of the id adds nothing; #771: one made before the
store's pruning mark and not held is refused), `deleteEntriesByMadeAtBefore(cutoff)` (#771) — and the last `maxSpend()` read per
budget and key (`findMaxSpendByAccount`, `saveMaxSpend`: "the last known limit" for a report
outside an execution). A period is named by its first UTC day: `2026-10-18` for that day,
`2026-10-12` for the week starting Monday the 12th, `2026-10-01` for the month; an execution budget's
counter has no period. Listed in `@Application({ providers })` (a class that
`extends CostLedgerRepository`), else the built-in in-memory one — each instance counts on its own
and the counters reset on restart; `SqliteCostLedgerRepository` (#265) shares them between the
instances on one file and survives a restart (a file written before budgets has its old per-workflow
day counters dropped).

#### Pruning the entries (#771)

An entry exists so that a write retried after its answer was lost counts once. Only the pass that
made a spend ever writes its entry — its own write and its retries, at its next read of the counters
or checkpoint; every other pass only counts a marked record, never writes it — so an entry is needed
while that pass may still retry. The ledger keeps entries `@Application({ retention: { costLedgerEntries } })`
after they were made (default `hours(24)`, above the lease's 30 s —
`[application.retention-invalid]`); every look of the recovery sweep calls
`deleteEntriesByMadeAtBefore(now − retention)` on the `Clock`. A prune never touches a counter.

The prune raises the store's **pruning mark** to its cutoff (never lowers it) and removes the
entries made before the mark, atomically against a save. A save of an entry made before the mark
that the store does not hold — it may have been counted and pruned since — is refused:
`CostLedgerEntryExpiredError` (`cost-ledger.entry-expired`), nothing of that save added, and the
pass's reads fail with it from then on. So a retry is never counted twice, whatever the clocks say:
the guarantee compares an entry's own `madeAt` with the mark, never two machines' times; the
retention only decides how late a retry may come before it is refused. Within it a lost answer
retried counts once; past it (a pass frozen for a day) the pass fails closed, and the ledger holds
the spend once if its first write landed — or not at all if it never did, the one case where an
entry's spend may be missing, which only a pass asleep longer than the retention reaches.

| store | entries | pruning mark |
| --- | --- | --- |
| in memory | a map of `ledgerId` → `madeAt` | a number in the instance |
| `SqliteCostLedgerRepository` | `cost_ledger_entries (ledger_id, made_at)`, indexed by `made_at`; a #727 file's entries dated "never" | `cost_ledger_entries_pruned`, read in the save's `BEGIN IMMEDIATE` |
| agbossjs/postgres | `agboss_cost_entries (ledger_id, made_at)` (migration `0023`) | `agboss_cost_entries_pruned`, read `FOR SHARE` in the save's statement |
| agbossjs/mongodb | `agboss_cost_entries` documents with `madeAt` | a document of `agboss_cost_entries` (`_id` `"\u0000pruned-before"`, made in the transaction that creates the collection, #798), read in the save's transaction |

The mark must exist for the guarantee to hold: a store that read a missing mark as "never pruned"
would accept a pruned entry saved again and count its spend twice. So the stores seed it once — in
the schema (SQLite, PostgreSQL migration `0023`) or in the transaction that creates the collection
(MongoDB) — and a mark deleted by hand (on MongoDB also one whose `prunedBefore` is no date) fails
every save closed, nothing added: `PostgresLedgerMarkMissingError`
(`postgres.ledger-mark-missing`), `MongoLedgerMarkMissingError` (`mongodb.ledger-mark-missing`, a
prune deletes nothing either; a restart never seeds it again). Each message is the remedy: put the
mark back no lower than any prune's cutoff (`now − retention.costLedgerEntries`). Keep it when you prune
or empty the entries by hand.

### Tests

A budget is unit-tested without the container:
`new ShopTenantDailyBudget(testExecutionContext({ tenantContext: ShopTenantContext, tenant: { tenantId: "acme", dailyBudgetUsd: 40 } }).tenant).maxSpend()`
is `usd(40)`. An application test reaches an exhausted budget the real way —
`mockOf(TenantDailyBudget).maxSpend.mockReturnValue(usd(0.01))` plus a scripted cost
(`replyWith(…, { cost: usd(0.02) })`) — and checks its own reaction (the `.onError` path, the
rejection). There is no `limits` option in `testWith`.

## Steps and visits

Counts protect the graph, not money ([Workflow](Workflow)):

| Limit | Error | Meaning |
| --- | --- | --- |
| `@Workflow({ maxSteps })` | `StepsLimitExceededError` (`workflow`, `maxSteps`, `steps`: `support-workflow took 41 steps; its maxSteps is 40`) | agent and router visits per execution (default (agents + routers) × 3) |
| `maxVisits` on `@Router` / `@Agent` | `VisitsLimitExceededError` (`component`, `nodeId`, `maxVisits`, `visits`) | visits of one node per execution |
| `@Workflow({ maxDepth })` (#264) | `DepthLimitExceededError` (`workflow`, `maxDepth`, `depth`: `topic-research-workflow went 5 levels deep; its maxDepth is 4`), in the `cause` of `ChildExecutionFailedError` | the levels a recursive workflow's executions run at, the root at 1 — a launch by code past it does not start ([Workflow as a step → Recursion](Workflow-as-a-step#recursion-264)) |

One class per limit, all subclasses of `LimitExceededError` (`.onError(LimitExceededError, …)` takes
any; codes `limit.steps`, `limit.visits`, `limit.budget`, `limit.depth`). A recursive tree's
executions each count their own `maxSteps`; its money is the root's budgets, every level included. `maxSteps` is checked at assembly:
`[limits.max-steps-too-low]` — no finish fits in a hand-set `maxSteps`, or the default cannot hold the
worst case of a per-item launch (`maxItems` runs: set `@Workflow({ maxSteps })`, the default never
grows silently) —, `[limits.branch-exceeds-max-steps]`, `[limits.max-steps-unused]`, and the warning
`[limits.max-steps-below-worst-case]` (#643; an error under `--strict`): a hand-set `maxSteps` below
the worst case of a flow whose every loop `maxVisits` bounds — each loop counted at its nodes'
`maxVisits`, its other nodes between two of their visits — would end a run with
`StepsLimitExceededError` before the loop's own `.onError(VisitsLimitExceededError, …)` does; the
message names the loop and the `maxSteps` that fits. A flow that takes the steps limit itself is not
warned.
`agboss studio` runs the flow graphs with their steps and visits limited; budgets are opened per
execution by the app, so Studio's own runs are not capped by them. Optional extra backstop outside
the app: a spending limit on the OpenRouter key itself.

## Concurrency of a tree (#264)

A tree of executions — a root and the child workflows it launches, a recursion of unknown depth
([Workflow as a step](Workflow-as-a-step)) — shares one cap: `@Workflow({ maxConcurrentExecutions: 6 })`
of the root, default 10, a whole number from 1 (`[limits.max-concurrent-executions-invalid]`). It is
how many executions of the tree work on a step at once — a throttle, never an error:

| What | How |
| --- | --- |
| a slot | an execution holds one while one of its working steps runs — an agent, a router, an action, a branch of a launch; its parallel branches share it; starts and finishes take none |
| no slot held | an execution waiting at a join, while its child runs, or paused — so the tree never deadlocks |
| a step without a free slot | waits in the tree's queue |
| the queue's order | a parent whose children have all finished (its step right after its child, or its children's join: it closes a branch), then the deepest execution; every `seconds(10)` of waiting counts as one level deeper, read from the application's `Clock` |
| a launch's `maxConcurrency` | holds too: the stricter of the launch's width and the tree's cap wins |
| a child's own `maxConcurrentExecutions` | a smaller one limits its subtree inside the tree's; a larger one is never reached — `[limits.child-concurrency-above-parent]`, a warning (an error under `--strict`) |
| a quorum's `deadline` | the time its branches wait for a slot does not count ([Parallel → The deadline](Parallel#the-deadline)) |
| a `FailFast` failure, a cancel | the waiting steps of the aborted launch leave the queue unstarted |
| a pause, a crash | for a local tree, the slots live in the process that holds the tree's lease ([Several instances](Several-instances)), never in a store; when the tree can launch a child on any instance (`ChildPlacement.AnyInstance`, #333 PR 3), its slots are leases in `RateLimitRepository` (`tree:<tenantId>:<rootExecutionId>` and `:subtree:<executionId>`, renewed while held, so a crashed instance's slot expires by itself); the next pass rebuilds the queue from the unfinished tasks |

What it is not: a slot is an execution, not model load — one execution may fan out into several
model calls (provider throughput is `rateLimitPolicy`, below); the cap is per tree, not per
application; the queue order is per instance (across instances, whoever acquires the lease first
gets the slot). `agboss describe` prints it for a workflow that
launches children: `maxConcurrentExecutions 6 (set) · executions of the tree at work at once`
(`10 (default)` when unset).

## Capacity is not money: rate limits

Budgets and steps protect money and the graph; a provider's **capacity** is its own policy
([Model providers](Model-providers#ratelimitpolicy), #266): `rateLimitPolicy` caps the calls in
flight and per minute for the whole application, and after a 429 slows every caller down. A call
waiting for room spends nothing and counts toward no budget; its real usage (tokens) is counted in
the provider's per-minute window after the call, as its cost is counted in the budgets. A retried
call is one call, paid once; a wait between its attempts holds no slot.

## Turn financials — part of every result

Every `ExecutionOutput` carries `spend` (`CostReport`) — the core always reports it; each client
decides what to show:

| Field                                  | Meaning                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `totalUsd`, `calls`, `cacheReadTokens` | the turn in total                                                                               |
| `byCategory`                           | `agents`, `routing`, `guards`, `review`, `tools`, `compaction`, `retrieval` — every key present |
| `byModel`, `byCaller`                  | the same money by model and by caller                                                           |
| `trace`                                | every call in order: caller, category, model, cost, how it was priced, tokens                   |

Categories come from the caller: `tool:*` → tools, `compaction:*` → compaction, `rag:*` → retrieval, `guardrail:*` → guards, `router:quality:*` →
review, other `router:*` → routing, an agent name → agents. A resumed (paused) run reports the whole
run.

The CLI and the chat print it every turn:

```
thread 6cc2173e-… · http://localhost:3000/project/…/sessions/6cc2173e-…
researcher · stop: jev confidence 0.96
agents $0.002332 · routing $0.000038 · guards $0.000033 · tools $0.001000
   1. guardrail:prompt-injection-guardrail  typesafe/jev-1.13  $0.000014  api-priced
   2. router:main                    typesafe/jev-1.13  $0.000016  api-priced
   3. researcher                     kimi-k2.6          $0.000426  306 in / 116 out
   5. tool:exchange-rate-tool             exchange-rate-tool      $0.001000  tool-reported
   …
total $0.003403 (8 calls)
```

`api-priced` = exact price from the provider (Jev bills per decision); `N in / M out` = tokens ×
price table; `tool-reported` = the tool's own cost.

## Eval spend

`agboss eval score` / `agboss replay` / `agboss compare` run within the application's budgets: a replayed or
compared execution is an execution like any (its tenant `"default"`), and stops the evaluation once a
tenant or application budget is exhausted; the judge's own calls are outside any execution — they are
counted in the application budgets and stop scoring once one is exhausted by its last known limit
(the `maxSpend()` the last execution read). See [Terns and evaluation](Terns-and-evaluation).

## Tests

Unit tests use fakes and cost $0; real calls only in `make smoke`.
