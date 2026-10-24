# Workflow as a step — child workflows

A step of a path may be a whole workflow (#263): an ordinary `@Workflow` of the same application,
runnable and testable on its own (`app.execute(VendorCheckWorkflowStart, …)`), used by its parent
as a component "start input → one of its finishes' outputs". It is the answer to a **chain of
steps per item** — check → deep dive → score, with its own branches, repeats and failures per item —
where a per-item launch of one agent (`.toParallelAgents(A)`) runs exactly one step per item
([Workflow → Parallel launches](Workflow#parallel-launches)).

> **Status.** #263 PR 1 — the grammar, the analyser and the generated types; PR 2 — children at run
> time: a subgraph node of the parent, their own executions, `ChildExecutionFailedError`, nested
> records (`result.children`), `toHaveChildExecutions` / `toHaveHandledError`, and a child as an
> error handler (`toWorkflow(W)` side paths). Recursion — `ThisWorkflow`, `maxDepth`, the soft stop
> — is #264 PR 1 ([below](#recursion-264)); the tree's `maxConcurrentExecutions` is #264 PR 2
> ([FinOps → Concurrency of a tree](FinOps#concurrency-of-a-tree-264)). A child on any instance —
> `placement: ChildPlacement.AnyInstance` — is #333 PR 2 ([below](#on-any-instance-333-pr-2)).
> Runnable examples: `examples/flow-patterns/src/vendor/`, `examples/flow-patterns/src/topic/`.

## Writing it

<!-- snippet-context
import { Action, Agent, LimitExceededError, StepFailedError, Workflow, WorkflowFinish, WorkflowStart, agent, caseOf, start, toAction, toFinish, workflow } from "agboss";
import { Flag, Text, WorkflowStartTextDto, listOf, oneOf, optional } from "agboss/dto";

export class VendorDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;
}
export class VendorLinkDto {
  @Text({ prompt: "a link to the vendor's page" })
  url!: string;
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
export class ContractDto {
  @Text({ prompt: "the contract" })
  text!: string;
}
@WorkflowStart({ name: "vendor-check-workflow-start", description: "One vendor", input: VendorDto })
export class VendorCheckWorkflowStart {}
@WorkflowStart({ name: "vendor-link-check-workflow-start", description: "A vendor by a link", input: VendorLinkDto })
export class VendorLinkCheckWorkflowStart {}
@Agent({ name: "vendor-checker-agent", description: "Checks a vendor", prompt: "Check it.", model: "moonshotai/kimi-k2.6", input: { vendor: optional(VendorDto), link: optional(VendorLinkDto) }, output: oneOf(VendorScoreDto, VendorRejectedDto) })
export class VendorCheckerAgent {}
@Action({ name: "mark-vendor-failed-action", description: "Records a failed check", output: VendorCheckFailedDto })
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
@WorkflowStart({ name: "contract-workflow-start", description: "Who to contract", input: WorkflowStartTextDto })
export class ContractWorkflowStart {}
@WorkflowStart({ name: "picked-contract-workflow-start", description: "Who to contract", input: WorkflowStartTextDto })
export class PickedContractWorkflowStart {}
@WorkflowStart({ name: "link-contract-workflow-start", description: "Contract the vendor behind a link", input: { message: WorkflowStartTextDto, link: VendorLinkDto } })
export class LinkContractWorkflowStart {}
@Agent({ name: "vendor-finder-agent", description: "Finds vendors", prompt: "Find them.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: listOf(VendorDto) })
export class VendorFinderAgent {}
@Agent({ name: "vendor-picker-agent", description: "Picks the vendor", prompt: "Pick one.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: VendorDto })
export class VendorPickerAgent {}
@Agent({ name: "vendor-ranker-agent", description: "Ranks", prompt: "Rank.", model: "moonshotai/kimi-k2.6", input: { checks: listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)) }, output: VendorRankingDto })
export class VendorRankerAgent {}
@Agent({ name: "contract-agent", description: "Writes the contract", prompt: "Write it.", model: "moonshotai/kimi-k2.6", input: { score: VendorScoreDto }, output: ContractDto })
export class ContractAgent {}
@Action({ name: "notify-operator-action", description: "Tells the operator", input: { vendors: listOf(VendorDto) } })
export class NotifyOperatorAction {
  async execute(): Promise<void> {}
}
@WorkflowFinish({ name: "vendor-ranking-workflow-finish", description: "The ranking", output: VendorRankingDto })
export class VendorRankingWorkflowFinish {}
@WorkflowFinish({ name: "screening-stopped-workflow-finish", description: "Stopped on a limit", output: WorkflowStartTextDto })
export class ScreeningStoppedWorkflowFinish {}
@WorkflowFinish({ name: "contract-workflow-finish", description: "The contract", output: ContractDto })
export class ContractWorkflowFinish {}
@WorkflowFinish({ name: "no-contract-rejected-workflow-finish", description: "Not a fit", output: VendorRejectedDto })
export class NoContractRejectedWorkflowFinish {}
@WorkflowFinish({ name: "no-contract-failed-workflow-finish", description: "Not checked", output: VendorCheckFailedDto })
export class NoContractFailedWorkflowFinish {}
@WorkflowFinish({ name: "check-error-workflow-finish", description: "The check failed", output: WorkflowStartTextDto })
export class CheckErrorWorkflowFinish {}
// @snippet
@Workflow({ name: "vendor-screening-workflow", version: "1.0.0", flow: perItemPaths })
export class VendorScreeningWorkflow {}
@Workflow({ name: "contract-workflow", version: "1.0.0", flow: inlinePaths })
export class ContractWorkflow {}
@Workflow({ name: "link-contract-workflow", version: "1.0.0", flow: ownPaths })
export class LinkContractWorkflow {}
-->

```ts
// the child: one vendor, entered by a VendorDto or by a link; its own branches and soft failure
@Workflow({
  name: "vendor-check-workflow",
  version: "1.0.0",
  flow: [
    start(VendorCheckWorkflowStart)
      .returns(VendorDto)
      .toAgent(VendorCheckerAgent),
    start(VendorLinkCheckWorkflowStart)
      .returns(VendorLinkDto)
      .toAgent(VendorCheckerAgent),
    agent(VendorCheckerAgent) // two ways in (two starts) → its own path
      .onError(
        StepFailedError, // caught inside the child: one more result class for the parent
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
  maxSteps: 10,
})
export class VendorCheckWorkflow {}

// a parent, per item: one child per VendorDto (through vendor-check-workflow-start), 3 at once
export const perItemPaths = [
  start(VendorScreeningWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(VendorFinderAgent)
    .returns(listOf(VendorDto))
    .toParallelWorkflows(VendorCheckWorkflow, { maxConcurrency: 3, maxItems: 50 })
    .join()
    .onJoinError(
      LimitExceededError, // a limit: only actions and finishes after it
      toAction(NotifyOperatorAction)
        .toFinish(ScreeningStoppedWorkflowFinish),
    )
    .returns(listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)))
    .toAgent(VendorRankerAgent)
    .returns(VendorRankingDto)
    .toFinish(VendorRankingWorkflowFinish),
] as const;

// a parent, one child, one way in: .onError right after it, one case per finish output class
export const inlinePaths = [
  start(ContractWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(VendorPickerAgent)
    .returns(VendorDto) // enters vendor-check-workflow-start
    .toWorkflow(VendorCheckWorkflow)
    .onError(StepFailedError, toFinish(CheckErrorWorkflowFinish))
    .returns(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto))
    .switch(
      caseOf(VendorScoreDto)
        .toAgent(ContractAgent)
        .returns(ContractDto)
        .toFinish(ContractWorkflowFinish),
      caseOf(VendorRejectedDto)
        .toFinish(NoContractRejectedWorkflowFinish),
      caseOf(VendorCheckFailedDto)
        .toFinish(NoContractFailedWorkflowFinish),
    ),
] as const;

// a parent, one child reached from two places: its own path, each edge with its own start
export const ownPaths = [
  start(PickedContractWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(VendorPickerAgent)
    .returns(VendorDto) // enters vendor-check-workflow-start
    .toWorkflow(VendorCheckWorkflow),
  start(LinkContractWorkflowStart)
    .returns(WorkflowStartTextDto)
    .returns(VendorLinkDto) // enters vendor-link-check-workflow-start
    .toWorkflow(VendorCheckWorkflow),
  workflow(VendorCheckWorkflow)
    .onError(StepFailedError, toFinish(CheckErrorWorkflowFinish))
    .returns(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto))
    .switch(
      caseOf(VendorScoreDto)
        .toAgent(ContractAgent)
        .returns(ContractDto)
        .toFinish(ContractWorkflowFinish),
      caseOf(VendorRejectedDto)
        .toFinish(NoContractRejectedWorkflowFinish),
      caseOf(VendorCheckFailedDto)
        .toFinish(NoContractFailedWorkflowFinish),
    ),
] as const;
```

| Form | |
| --- | --- |
| `.toWorkflow(W)` | one child execution of `W`; also `route(W)` among a router's routes |
| `.toParallelWorkflows(W, { maxConcurrency, maxItems })` | one child per item, right after `.returns(listOf(ItemDto))` (else it does not compile); one workflow class; `maxItems` required; followed by `.join()` like any launch ([Workflow → Parallel launches](Workflow#parallel-launches)); a router launches agents only |
| One way in → inline | a child reached from one place is continued right after `.toWorkflow(W)` (`.onError(…)`, `.returns(…)`, `.switch(…)`); an own path for it → `[flow.single-entry-own-path]` |
| Two or more ways in → own path | `workflow(W).onError(…).returns(oneOf(…)).switch(…)`; every path into it ends with `.toWorkflow(W)`; inline → `[flow.shared-node-inline]` |
| One class = one node | `W` mentioned again in the graph is the same node; two stages running the same child are two workflow classes (`[flow.continuation-twice]`) |
| The kind is checked | `toAgent(VendorCheckWorkflow)` does not compile, and is `[graph.wrong-kind]` in untyped code |
| Not listed | a child need not be in `@Application({ workflows })`: it belongs to its parent's application, which assembles it and runs it alone through its own starts (`app.execute(VendorCheckWorkflowStart, …)`) |

## Which start

The start is chosen **per edge into the child**, by class — it is never named, so two paths into
`workflow(W)` may enter through two starts (above: `vendor-check-workflow-start` from the picker,
`vendor-link-check-workflow-start` from the link):

| Edge | Start |
| --- | --- |
| The child has one start | it — also after an action without `output` or from `route(W)`, where the chain carries no value |
| Per item (`.toParallelWorkflows`) | the start with a required field of the item's type; the item fills it |
| Single launch (`.toWorkflow`, a join's `.to…`) | the start with a required field of the chain's current value — the `.returns` / `caseOf` right before |
| Several such starts | the one whose other required fields are all on the parent's path |

None → `[graph.no-matching-start]`, naming the starts and their inputs; still two →
`[graph.ambiguous-start]`, fixed by a subclass as one start's input
(`class QuickCheckRequestDto extends VendorDto {}`). Both are compile errors too: the child's
generated `Inputs` entry carries the message, so `.toWorkflow(W)` does not compile. A start's input
may be a list (`input: listOf(VendorDto)` takes a whole list, `.returns(listOf(VendorDto)).toWorkflow(W)`)
or a map of fields (`{ vendor: VendorDto, request: optional(SearchRequestDto) }`): the item or the
current value fills its field, the other fields come from the parent's path, and an optional one
may be missing — the same child is entered from parents that have it and parents that do not.
`agboss describe` prints each edge's start:

```text
children
  vendor-finder-agent → vendor-check-workflow per item: vendor-check-workflow-start (VendorDto)
  link-contract-workflow-start → vendor-check-workflow: vendor-link-check-workflow-start (VendorLinkDto)
```

## What it sees, what it gives

- **The child's scope starts with its start input only**: nothing of the parent's scope is visible
  inside it ([Path scope → Child workflows](Path-scope#child-workflows)). A node of the child that
  reads a class only the parent has is `[input.missing-on-path]` in the child's own check; on the
  parent's side the chosen start's required fields must be on every path into the edge
  (`[input.missing-on-path]`, `[input.outdated-on-path]`, `[input.several-on-path]`).
- **It gives back one value**: the output of the finish it ended at. Its result is the set of its
  finishes' output classes — `.returns(XDto)` for one class, `.returns(oneOf(…)).switch(caseOf(…)…)`
  with exactly one case per class otherwise (a missing or extra class →
  `[flow.switch-not-exhaustive]` / `[flow.switch-unknown-case]`, and a compile error through
  `ProducerOutputs`). Two finishes with one output class are one case. A `caseOf(XDto)` counts as
  reading `XDto` (`[flow.unused-output]` never fires on a branch that ends in a finish).
- After a per-item launch the join gives **one polymorphic list**:
  `.join().returns(listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)))`,
  checked against the generated `JoinOutputs` entry `toParallelWorkflows(vendor-check-workflow) per item`;
  a node reads it as that `listOf(oneOf(…))` field (#299 S53: no filtered `listOf(VendorScoreDto)` slot).

## Errors

| Where | |
| --- | --- |
| One child, one way in | `.onError(E, path)` right after `.toWorkflow(W)` |
| One child, own path | `.onError(E, path)` right after `workflow(W)` |
| Per item | `.onJoinError(E, path)` right after the join — `.onError` there does not compile, nor `.onJoinError` after `.toWorkflow(W)` |
| Soft failure | an error the child catches itself, ending at a failure finish (`VendorCheckFailedDto` above), is one more ordinary result class for the parent — the way to skip a failed item and go on |
| No soft failure | a per-item child with no finish reachable from one of its `.onError` side paths warns `[graph.child-without-failure-finish]` — one failed item would cancel the others (FailFast); an error under `agboss check --strict`; no flag silences it |
| After a limit | a side path that can catch a `LimitExceededError` — the class, a subclass (`BudgetExceededError`, `VisitsLimitExceededError`, …) or a parent (`AGBossError`, `Error`) — leads only to actions and finishes, never paying past the limit: `[graph.limit-handler-uses-model]` when it reaches an agent, a router or a child workflow. This holds for every `.onError` / `.onJoinError`, not only a child's |

### At run time: whose limit it is (S25)

An uncaught error of the child fails it, and the parent's step fails with
**`ChildExecutionFailedError`** (`step.child`, a `StepFailedError`): `cause` — the child's error,
`childExecutionId`, `itemIndex` (a per-item run's), `workflow`, and the step's coordinates
(`component`, `nodeId`, `visitNumber`). The child's **own limits** are failures of the child and
wrapped the same way: its `maxSteps` (`StepsLimitExceededError` in `cause`), the `maxVisits` of its
nodes. So `.onError(StepFailedError, …)`, `.onError(ChildExecutionFailedError, …)` and
`.onJoinError(…)` at the parent take them, and their side path may lead to an agent — the parent's
steps and the tree's money are not spent. A handler naming the cause (`.onError(ItemFailedError,
…)`, `.onError(StepsLimitExceededError, …)`) catches it through the cause chain; naming a limit, it
leads only to actions and finishes.

**Tree-wide limits are never wrapped**: an exhausted budget (`BudgetExceededError`) and a
cancellation (`ExecutionCancelledError`) stop the whole execution as they are — `.onError(StepFailedError, …)`
never takes them. Every call of the tree is counted the moment it is made (#338): when one child's
call exhausts a budget, the model and tool calls in flight of its sibling children (and of every
other branch of the tree) are aborted at once, those children fail with that `BudgetExceededError`
and their spend so far, and the join takes `.onJoinError(BudgetExceededError, …)`
([FinOps → At run time](FinOps#at-run-time)). Per item, FailFast holds: the running children are cancelled (their spend stays
counted, their observers get `onExecutionError` with `ExecutionCancelledError`), no new one starts,
and the join takes `.onJoinError(…)` against the parent's scope **as it was before the launch** —
the children that finished first are in `result.children` / `result.record.children` and the
traces, never in the side path's scope. There is no `FailurePolicy.Skip` for children: skipping a
failed item is the child catching its error and ending at a failure finish.

## A child as an error handler (S85)

`toWorkflow(W)` is a side-path starter beside `toAction` / `toAgent` / `toRouter` / `toFinish`, in
`.onError` and `.onJoinError`: a failure is handled by a whole workflow, entered through its one
start (or the start the path's value fits), its result continued like after `.toWorkflow(W)`. A
side path that can catch a limit stays actions and finishes only
(`[graph.limit-handler-uses-model]`).

<!-- snippet-context
import { Action, StepFailedError, Workflow, WorkflowFinish, WorkflowStart, start, toWorkflow } from "agboss";
import { Text } from "agboss/dto";
export class PaymentDto {
  @Text({ prompt: "the payment" })
  id!: string;
}
export class PaymentDoneDto {
  @Text({ prompt: "what was paid" })
  receipt!: string;
}
@WorkflowStart({ name: "pay-workflow-start", description: "A payment", input: PaymentDto })
export class PayWorkflowStart {}
@Action({ name: "charge-card-action", description: "Charges the card", input: { payment: PaymentDto }, output: PaymentDoneDto })
export class ChargeCardAction {
  execute(): Promise<PaymentDoneDto> {
    return Promise.resolve({ receipt: "r" });
  }
}
@Action({ name: "invoice-action", description: "Sends an invoice", input: { payment: PaymentDto }, output: PaymentDoneDto })
export class InvoiceAction {
  execute(): Promise<PaymentDoneDto> {
    return Promise.resolve({ receipt: "invoice" });
  }
}
@WorkflowStart({ name: "payment-recovery-workflow-start", description: "A failed payment", input: PaymentDto })
export class PaymentRecoveryWorkflowStart {}
@WorkflowFinish({ name: "invoiced-workflow-finish", description: "Invoiced", output: PaymentDoneDto })
export class InvoicedWorkflowFinish {}
@Workflow({
  name: "payment-recovery-workflow",
  version: "1.0.0",
  flow: [
    start(PaymentRecoveryWorkflowStart)
      .returns(PaymentDto)
      .toAction(InvoiceAction)
      .returns(PaymentDoneDto)
      .toFinish(InvoicedWorkflowFinish),
  ],
})
export class PaymentRecoveryWorkflow {}
@WorkflowFinish({ name: "paid-workflow-finish", description: "Paid", output: PaymentDoneDto })
export class PaidWorkflowFinish {}
@WorkflowFinish({ name: "recovered-workflow-finish", description: "Paid another way", output: PaymentDoneDto })
export class RecoveredWorkflowFinish {}
// @snippet
@Workflow({ name: "pay-workflow", version: "1.0.0", flow: recoveryPaths })
export class PayWorkflow {}
-->

```ts
export const recoveryPaths = [
  start(PayWorkflowStart)
    .returns(PaymentDto)
    .toAction(ChargeCardAction)
    .onError(
      StepFailedError, // the charge failed: the recovery workflow takes it from here
      toWorkflow(PaymentRecoveryWorkflow)
        .returns(PaymentDoneDto)
        .toFinish(RecoveredWorkflowFinish),
    )
    .returns(PaymentDoneDto)
    .toFinish(PaidWorkflowFinish),
] as const;
```

## At run time

A child is a **node of its parent whose subgraph is the child's compiled graph** (S37): LangGraph
Studio draws it inside the parent (`getGraphAsync({ xray: true })`). It is a **run of its own**
([ADR-0022](ADR-0022-Child-workflows-as-runs-of-their-own), #333): its graph runs as a root graph on
its own checkpoint thread, `<parentThreadId>/child/<childExecutionId>` — never a thread of the API,
not listed, not addressable by `execute` / `cancel` — awaited inside its parent's step. The
launching task's `checkpoint_ns` on the parent's thread (the node and the task's id, so a second pass
of a loop or a neighbouring item is another task) holds only a marker: the child's identity and its
thread. A child that rests at a pause makes its parent's node interrupt with a **waiting marker** (no
pause: it never reaches a channel or `result.pending`); the tree rests as for any pause, its pending
pauses are read through the markers, and a resume — one command for the tree — is forwarded by the
parent's node to the child's thread. A child that started before ADR-0022 (its whole state under its
task) is continued that way. One class is one node; only `ThisWorkflow` (#264) is run from the
registry — the workflow's own compiled graph, never its own subgraph ([Recursion](#recursion-264)).

| | |
| --- | --- |
| Identity | its own `executionId`, made on its first entry and kept in its launching task's marker: a pause, a restart or a crash continues it with the same id, from its own thread's last checkpoint — no second `onExecutionStart`, finished siblings not run again |
| What it sees | its start's input only: no thread history, nothing of the parent's scope or its siblings; its own path, steps and `maxSteps` |
| Inherited | the thread, `ownerId`, the tenant (`executionContext.tenant`, the same `TenantContext` and `ApplicationContext`) and the execution's own fields of the declared `ExecutionContext` — through its state, so a resume keeps them |
| The tree | `executionContext.parent`, `.root`, `.depth`, `.itemIndex` (a per-item child's index from 0; `undefined` for a single child and a root), `.executionOf(W)` — the nearest execution of `W` from this one up, at any depth; `ExecutionTreeRepository` keys are the root's |
| Money | a child spends from the **root's** budgets — the root's execution budget is the cost of one full pass, children included; its own spend is counted in the tenant and application budgets too, the moment each call is made (#338: its siblings see it while they run); a child workflow's own execution budget applies only when it runs as the root (`app.execute`) |
| PII tokens | it starts with the parent's token map (#120), so it reveals what the parent masked; its own come back with its value — or, when it fails, with its error into the parent's state (never on the error itself), so the side path that takes it reveals what the child masked in its finished steps; a per-item child's too |
| Steps | each workflow counts its own: a child's steps never spend the parent's `maxSteps` |
| Concurrency | `maxConcurrency` of a per-item launch: a sliding window, a child frees its slot when it ends, fails or pauses |
| Pauses | a paused child does not stop its siblings — the execution pauses only when nothing else can move; its pause is the root's, in `result.pending` with its `childExecutionId` (and `itemIndex` per item), and `app.resume({ pauseId, decision })` continues it where it waits; once resolved, it is in the child's record as `pauses` (#267 S124) ([Pauses](Pauses)). A sibling child's failure under `FailFast`, or a decided quorum, withdraws a waiting child's pauses (#337: a pause records the launch branches above it) |
| Traces | a nested run named after the child workflow under the parent's step, its metadata `executionId`, `parentExecutionId`, `rootExecutionId`, `itemIndex` |

**Records.** Every child execution that ended is a nested record in `result.children` (and
`result.record.children`), in the order they ended — never in the thread's conversation history:
`executionId`, `parentExecutionId`, `rootExecutionId`, `workflow`, `itemIndex`, `launchedBy`
(`nodeId`, `visitNumber`), `start`, `input`, `status` (`ChildExecutionStatus.Finished` /
`Failed` / `Cancelled`), `finish` and `output` or `error`, its own `path`, its own `spend` and its own
`children`. `result.spend` holds the whole tree's. `result.handledErrors` lists the failures a side
path took (`error`, `at`, `by`).

**A child is the unit of work for its undo (#340 Q2).** A child's undoable actions
(`@Action({ compensateWith })`) are its own records: its finish commits them — a parent's later
failure, or its join's, never undoes a finished child. A child that ends without a finish — it
failed, it was cancelled, or its launch's `FailFast` aborted it — undoes its own open actions,
newest first, in its parent's step before its error reaches the parent (#340 PR 3,
`ExecutionFailed` / `ExecutionCancelled`): its records come from its checkpoint and the instance's
registry, never from the last state the parent saw; the undone records go into the parent's state
with the error, so a later pass never undoes them again; its `onExecutionError` lists them
(`compensations`). If one of its undo actions fails, its error is `CompensationFailedError`, which
passes the boundary as it is — never `ChildExecutionFailedError`, like a cancel or an exhausted
budget — so no `.onError` / `.onJoinError` of the parent takes it; the parent, getting it uncaught,
undoes its own open actions in turn. [Rollback](Rollback#an-execution-that-ends-without-a-finish).

**The application's rules.** A child need not be listed in `@Application({ workflows })`: the
workflows are collected transitively, and an unlisted child goes through every rule a listed one
does — names (`[name.kind-suffix]`, `[graph.duplicate-node-name]`), its models
(`[model.unserved]`, `[model.ambiguous-provider]`), DI and infrastructure (`[di.*]`, infrastructure
only in the application's `providers`, so `[environment.missing-field]` comes from what the
application lists), channel roles. Budgets aside: a child spends from its root's, so it needs no
execution budget of its own.

**Worst case.** The start log and `describe` count the children: one call of a start is the
execution itself plus each child edge's worst case, `maxItems` times per item (at most
`maxConcurrency` at once) — `Worst case of one vendor-screening-workflow-start call: 51 workflow
executions, 4 at the same time, …`.

## On any instance (#333 PR 2)

By default a child runs on its parent's instance, inside its parent's step. A launch may let **any
instance** of the application run it instead — a fan-out of heavy children then spreads over the
instances that share the stores ([Several instances](Several-instances#children-on-any-instance-333)):

<!-- snippet-context
import { Agent, ChildExecutionFailedError, Workflow, WorkflowFinish, WorkflowStart, start, toFinish } from "agboss";
import { Text, WorkflowStartTextDto, listOf } from "agboss/dto";
export class SupplierDto {
  @Text({ prompt: "the supplier's name" })
  name!: string;
}
export class SupplierScoreDto {
  @Text({ prompt: "how well the supplier fits" })
  score!: string;
}
export class SupplierRankingDto {
  @Text({ prompt: "the suppliers, best first" })
  order!: string;
}
@WorkflowStart({ name: "supplier-check-workflow-start", description: "One supplier", input: SupplierDto })
export class SupplierCheckWorkflowStart {}
@Agent({ name: "supplier-checker-agent", description: "Checks a supplier", prompt: "Check it.", model: "moonshotai/kimi-k2.6", input: { supplier: SupplierDto }, output: SupplierScoreDto })
export class SupplierCheckerAgent {}
@WorkflowFinish({ name: "supplier-scored-workflow-finish", description: "Scored", output: SupplierScoreDto })
export class SupplierScoredWorkflowFinish {}
@Workflow({
  name: "supplier-check-workflow",
  version: "1.0.0",
  flow: [
    start(SupplierCheckWorkflowStart)
      .returns(SupplierDto)
      .toAgent(SupplierCheckerAgent)
      .returns(SupplierScoreDto)
      .toFinish(SupplierScoredWorkflowFinish),
  ],
})
export class SupplierCheckWorkflow {}
@WorkflowStart({ name: "supplier-screening-workflow-start", description: "What to look for", input: WorkflowStartTextDto })
export class SupplierScreeningWorkflowStart {}
@Agent({ name: "supplier-finder-agent", description: "Finds suppliers", prompt: "Find them.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: listOf(SupplierDto) })
export class SupplierFinderAgent {}
@Agent({ name: "supplier-ranker-agent", description: "Ranks", prompt: "Rank.", model: "moonshotai/kimi-k2.6", input: { scores: listOf(SupplierScoreDto) }, output: SupplierRankingDto })
export class SupplierRankerAgent {}
@WorkflowFinish({ name: "supplier-ranking-workflow-finish", description: "The ranking", output: SupplierRankingDto })
export class SupplierRankingWorkflowFinish {}
@WorkflowFinish({ name: "screening-failed-workflow-finish", description: "A check failed", output: WorkflowStartTextDto })
export class ScreeningFailedWorkflowFinish {}
// @snippet
@Workflow({ name: "supplier-screening-workflow", version: "1.0.0", flow: anyInstancePaths })
export class SupplierScreeningWorkflow {}
-->

```ts
import { ChildPlacement } from "agboss";

export const anyInstancePaths = [
  start(SupplierScreeningWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(SupplierFinderAgent)
    .returns(listOf(SupplierDto))
    .toParallelWorkflows(SupplierCheckWorkflow, {
      maxConcurrency: 6,
      maxItems: 50,
      placement: ChildPlacement.AnyInstance, // default ChildPlacement.ParentInstance
    })
    .join()
    .onJoinError(ChildExecutionFailedError, toFinish(ScreeningFailedWorkflowFinish))
    .returns(listOf(SupplierScoreDto))
    .toAgent(SupplierRankerAgent)
    .returns(SupplierRankingDto)
    .toFinish(SupplierRankingWorkflowFinish),
] as const;
```

- **Where it is written**: `{ placement }` on `.toWorkflow(W, { placement })`,
  `.toParallelWorkflows(W, { …, placement })` and `route(W, { placement })`; absent is
  `ChildPlacement.ParentInstance`. One class is one node, so all its mentions name one placement
  (`[flow.conflicting-placement]`). `describe` and the config fingerprint print it as written.
- **How the parent waits — inside its step (#333 S6, S9)**: the parent's node saves the child to the
  application's `ChildExecutionQueueRepository` (once: a re-entry after a crash finds its row and
  waits again, no second row) and waits on that row — woken at once when the child ends in the same
  process, else reading it every second on the framework's `Clock`. While waiting, the parent yields
  its lease in `ExecutionLeaseRepository` and re-acquires it before continuing. The wait is under
  the step's own signal, so a `FailFast` sibling, `app.cancel`, a lost lease, an exhausted budget
  and the failure records take the same paths as for a child on the parent's instance.
- **Who runs it**: an instance with a free step slot ([#332](Several-instances#an-instances-cap-on-steps-332);
  no cap → always) claims it — at once when it was queued in the same process, else at its next sweep
  (30 s) — the deepest first, then the longest waiting. It holds a 30 s lease in
  `ExecutionLeaseRepository` under `(tenantId, childExecutionId)`, runs as a root graph on the
  child's own thread (the same graph and `ExecutionContext` — parent, root, depth, `itemIndex`,
  tenant, thread — as on the parent's instance) and completes the row; the parent reads the child's
  last state from that thread, so its value, PII tokens, spend and record come back as for a local
  child.
- **Pauses and per-child recovery (#333 PR 4, S7, S9)**: when a remote child rests at a pause, its
  worker completes the pass at `Paused` and the parent's node interrupts with a `remote: true`
  waiting marker so the pause appears in `result.pending` with its `childExecutionId` and `itemIndex`
  and records `PauseAnswerRecord` in `result.children[i].pauses` and `result.record.pauses`; on
  `app.resume` from any instance, the parent's node forwards the child's resume map through the
  queue so any instance continues only that child on `<parentThreadId>/child/<id>`. On a worker
  crash or a graceful stop past `shutdownTimeout` (S7), the queue row stays `Running`; once the
  child's lease in `ExecutionLeaseRepository` is free, another instance reclaims only that child and
  continues it from its last checkpoint without re-running finished siblings.
- **Its failure** reaches the parent as `ChildExecutionFailedError`, its cause chain kept as the
  names, codes and messages of the child's errors (`RemoteChildFailure`): a side path on
  `ChildExecutionFailedError` (or `StepFailedError`, …) takes it; matching the child's own error
  class through the cause is not possible yet.
- **A cancel or the tree's end** stops a child running on another instance at its next look (every
  10 s); the tree's queue rows are removed when its root ends.
- **Tree-wide limits hold where it runs (#333 PR 3)**: its depth (`maxDepth`), the root's budgets
  and the tree's `maxConcurrentExecutions` ([FinOps](FinOps#concurrency-of-a-tree-264)) are checked
  on the worker — the tree's slots are held as leases in `RateLimitRepository` (`tree:<tenantId>:<rootExecutionId>`
  and `:subtree:<executionId>`), and each superstep's spend is written to the root's counters in
  `CostLedgerRepository` at once (never counted twice when the parent folds the child's state in).

## Recursion (#264)

A workflow launches **itself** with the marker `ThisWorkflow` — a decorator's arguments are
evaluated before its class exists, so the class cannot name itself: `.toWorkflow(ThisWorkflow)`,
`route(ThisWorkflow)`, `.toParallelWorkflows(ThisWorkflow, { maxConcurrency, maxItems })`.
Everything else is a child's: its start chosen by class, its scope its start input only, its result
one of its finishes' outputs, its errors and limits. `ThisWorkflow` is one node, `this-workflow`
(from two places: its own path `workflow(ThisWorkflow)…`). A topic too broad for one report is split
and each subtopic researched the same way:

<!-- snippet-context
import { Action, Agent, StepFailedError, ThisWorkflow, Workflow, WorkflowFinish, WorkflowStart, action, caseOf, start, toAction, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { Integer, ListOf, Text, listOf, oneOf } from "agboss/dto";

export class TopicDto {
  @Text({ prompt: "the topic" })
  title!: string;
  @Integer({ prompt: "how deep the topic is: 0 for the first one" })
  level!: number;
}
export class TopicReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}
export class TopicTooBroadDto {
  @ListOf(Text, { prompt: "the subtopics" })
  subtopics!: string[];
}
export class TopicFailedDto {
  @Text({ prompt: "the topic" })
  title!: string;
}
@WorkflowStart({ name: "topic-research-workflow-start", description: "A topic", input: TopicDto })
export class TopicResearchWorkflowStart {}
@Agent({
  name: "researcher-agent",
  description: "Researches a topic, or lists its subtopics",
  prompt: "Research the topic, or say it is too broad and list its subtopics.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto },
  output: oneOf(TopicReportDto, TopicTooBroadDto),
})
export class ResearcherAgent {}
@Agent({
  name: "merge-agent",
  description: "Merges the subtopics' results",
  prompt: "Merge the reports into one report on the topic.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto, results: listOf(oneOf(TopicReportDto, TopicFailedDto)) },
  output: TopicReportDto,
})
export class MergeAgent {}
@Action({
  name: "subtopics-action",
  description: "Splits a topic into subtopics",
  input: { topic: TopicDto, tooBroad: TopicTooBroadDto },
  output: listOf(TopicDto),
})
export class SubtopicsAction implements ActionHandler<SubtopicsAction> {
  execute(input: InputOf<SubtopicsAction>): Promise<OutputOf<SubtopicsAction>> {
    const { level } = input.topic.value;
    return Promise.resolve(input.tooBroad.value.subtopics.map((title) => ({ title, level: level + 1 })));
  }
}
@Action({
  name: "mark-topic-failed-action",
  description: "Records a topic that could not be researched",
  input: { topic: TopicDto },
  output: TopicFailedDto,
})
export class MarkTopicFailedAction implements ActionHandler<MarkTopicFailedAction> {
  execute(input: InputOf<MarkTopicFailedAction>): Promise<OutputOf<MarkTopicFailedAction>> {
    return Promise.resolve({ title: input.topic.value.title });
  }
}
@WorkflowFinish({ name: "topic-report-workflow-finish", description: "The report", output: TopicReportDto })
export class TopicReportWorkflowFinish {}
@WorkflowFinish({ name: "topic-failed-workflow-finish", description: "No report", output: TopicFailedDto })
export class TopicFailedWorkflowFinish {}
-->

```ts
@Workflow({
  name: "topic-research-workflow",
  version: "1.0.0",
  flow: [
    start(TopicResearchWorkflowStart)
      .returns(TopicDto)
      .toAgent(ResearcherAgent)
      .onError(StepFailedError, toAction(MarkTopicFailedAction)) // a failed topic is skipped softly
      .returns(oneOf(TopicReportDto, TopicTooBroadDto))
      .switch(
        caseOf(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
        caseOf(TopicTooBroadDto) // left out of the researcher's schema on the last level
          .toAction(SubtopicsAction)
          .returns(listOf(TopicDto))
          .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 5 })
          .join()
          .returns(listOf(oneOf(TopicReportDto, TopicFailedDto)))
          .toAgent(MergeAgent)
          .onError(StepFailedError, toAction(MarkTopicFailedAction))
          .returns(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
      ),

    action(MarkTopicFailedAction) // two ways in: its own path
      .returns(TopicFailedDto)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  maxDepth: 3,
})
export class TopicResearchWorkflow {}
```

**The depth.** `@Workflow({ maxDepth })` is required on a workflow that can reach `ThisWorkflow`
(`[graph.recursion-without-depth]`, a whole number from 1). `executionContext.depth` is 1 at the
root, 2 for its children and so on — the same in every child record (`result.children[…].depth`) and
in each child's trace metadata — so `maxDepth: 3` allows levels 1–3 and the last level is
`depth === maxDepth`. No model sees the depth (Q52): instructions are static and context values
never enter a prompt; a level the domain cares about is data in `input` — `TopicDto.level`, set by the
action that splits a topic. The two differ anyway: a recursive workflow started as someone's child
starts deeper than 1 while its first topic's `level` is 0.

**The soft stop.** On the last level the framework, not the prompt, stops the recursion. Of every
branch — a `.switch(caseOf(…))`, a `.chooseOne(route(…))` — the options whose path launches
`ThisWorkflow` before the next branch are not offered:

| Who decides | On the last level |
| --- | --- |
| an agent's `oneOf` answer | the recursive variants' answer tools are not bound and the answer is checked against the narrowed schema — a second static request prefix, so a second cache prefix for that level ([Agents](Agents)) |
| a model router | its model does not see the recursive routes (one route left: chosen without a model call) |
| a code router | `route()` returning one fails with `RouterDecisionError` — "not ready on the last level" |
| code or data (an action's or a child's `oneOf`, a launch with no branch) | the launch past `maxDepth` does not start: the hard stop below |

So every branch with a recursive option keeps one that is not (`[graph.recursion-without-exit]`); a
path with no branch at all — an action whose list of subtopics comes back empty — ends by its data.

**The hard stop.** A launch decided by code past `maxDepth` does not start — no execution, no
`onExecutionStart` — and fails the launching step with `ChildExecutionFailedError` caused by
`DepthLimitExceededError` (`limit.depth`; `workflow`, `maxDepth`, `depth`: `topic-research-workflow
went 5 levels deep; its maxDepth is 4`). It is a child's own limit (S25): `.onError(LimitExceededError,
…)` right after `.toWorkflow(ThisWorkflow)`, or `.onJoinError(LimitExceededError, …)` after a per-item
launch's join, takes it — leading only to actions and finishes (`[graph.limit-handler-uses-model]`).
The refused launch is a failed child record with an empty path.

**The tree.** Each execution has its own `maxSteps`; the root's execution budget is the whole pass,
every level included, and the tenant and application budgets count it too. Only direct recursion:
a workflow launching one that launches it again — or naming its own class — is
`[graph.mutual-recursion]` (as is a class `undefined` while the flow is built, the trace of a
circular import). At run time `ThisWorkflow` is the workflow's own compiled graph, taken from the
registry when its step runs (a graph cannot contain itself): each level on its own child thread,
pauses inside any level resumed like any child's, through every waiting marker above it; Studio draws it
as the node `this-workflow`, which `getGraphAsync({ xray: true })` marks `recursive: maxDepth 3` in its
metadata ([CLI → Watch mode and Studio](CLI#watch-mode-and-studio-268)).

**The tree's cap.** `maxDepth` bounds how deep the tree goes, the launches' `maxConcurrency` how
wide one launch goes, and the root's `@Workflow({ maxConcurrentExecutions: 6 })` (default 10) how many
of the tree's executions work at once — the stricter wins. A level whose children run holds no slot,
so a cap of 1 still finishes; the queue serves a level closing its branch first, then the deepest
([FinOps → Concurrency of a tree](FinOps#concurrency-of-a-tree-264)).

**Seen in.** `agboss describe`: `recursive: ThisWorkflow, maxDepth 3, on the last level:
researcher-agent → TopicReportDto only`, and each input with its producers — `merge-agent ← topic:
topic-research-workflow-start, results: this-workflow ×0–5`: the execution's own topic from its start,
never a subtopic (a `listOf(TopicDto)` never fills one `TopicDto` field). The worst case counts the
levels down to `maxDepth`.

**Typed per path (S112).** `ThisWorkflow` is one class for every recursive workflow, so what it
gives is not one project-wide entry: `agboss check` writes one `ThisWorkflowOutputs` entry per
recursive workflow, keyed by its `name` — `input` (the problems of launching it, or `NoInput`),
`output` (what one child gives: its finishes' outputs) and, with a per-item launch, `join`:

```ts no-check: an excerpt of a generated .agboss/types.d.ts
interface ThisWorkflowOutputs {
  "topic-research-workflow": { readonly input: NoInput; readonly output: TopicFailedDto | TopicReportDto; readonly join: readonly (TopicFailedDto | TopicReportDto)[] };
  "org-chart-workflow": { readonly input: NoInput; readonly output: OrgChartFailedDto | TeamChartDto; readonly join: readonly (OrgChartFailedDto | TeamChartDto)[] };
}
```

A `.returns(…)` right after a `ThisWorkflow` launch — `.toWorkflow(ThisWorkflow)`, `route(ThisWorkflow)`,
`workflow(ThisWorkflow)`, the side-path starter `toWorkflow(ThisWorkflow)`, or the `.join()` of
`.toParallelWorkflows(ThisWorkflow, …)` — is not checked where it is written: the path's type
carries it as a claim through every sub-path (`caseOf`, `route`, `.switch`, `.chooseOne`,
`.onError`, `.onJoinError`) up to `@Workflow({ name, flow })`, which checks every claim of its flow
against its own entry. A wrong class is a compile error on `flow` (`a .returns(…) after
ThisWorkflow is not what org-chart-workflow gives — see ThisWorkflowOutputs["org-chart-workflow"]["output"]`);
the project code is the same as for any child. Several recursive workflows with different finishes
live in one project.

## Testing

```ts no-check: the matchers on a result of the vendor screening above
expect(result).toHaveChildExecutions(VendorCheckWorkflow, [
  { item: { name: "Acme" }, finish: VendorScoredWorkflowFinish },
  { item: { name: "Globex" }, failedWith: StepsLimitExceededError },
  { item: { name: "Initech" }, cancelled: true },
]);
expect(result).toHaveHandledError(ChildExecutionFailedError, {
  at: VendorCheckWorkflow,
  by: NotifyOperatorAction,
});
```

`toHaveChildExecutions(W, [...])` — the executions of `W` anywhere in the result's tree, in item
order, each with its `item` (its start input, or one field of a map input) and how it ended:
`finish`, `failedWith` (a class of its error or of a cause) or `cancelled`. `toHaveHandledError(E, {
at, by })` — an error of `E` (or caused by one) happened at `at` and the side path starting at `by`
took it. [Testing](Testing) has the rest.

## Patterns

- *Waves*: `.toParallelAgents(A)` → `.join()` → an action mapping to the next list →
  `.toParallelAgents(B)` — everyone together, step by step, the same short chain for all.
- *A child workflow per item*: each item its own way — no barrier between its steps, its own
  branches, repeats and failure isolation.
- *A child workflow to keep a path shallow*: a branch deeper than 4 levels (`[flow.path-too-deep]`)
  moves into a child.
