# Workflow as a step — child workflows

A step of a path may be a whole workflow (#263): an ordinary `@Workflow` of the same application,
runnable and testable on its own (`app.execute(VendorCheckWorkflowStart, …)`), used by its parent
as a component "start input → one of its finishes' outputs". It is the answer to a **chain of
steps per item** — check → deep dive → score, with its own branches, repeats and failures per item —
where a per-item launch of one agent (`.toParallelAgents(A)`) runs exactly one step per item
([Workflow → Parallel launches](Workflow#parallel-launches)).

> **Status.** PR 1 of #263: the grammar, the analyser and the generated types — `agboss check` checks
> and types every child, `agboss describe` prints each edge's start. Running a child (a subgraph of
> its parent, its own `maxSteps`, `ChildExecutionFailedError`, nested records) comes with #263 PR 2;
> until then a workflow with a child does not assemble (`flow.child-not-runnable`).

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

At run time (#263 PR 2) an uncaught failure of a child reaches its parent as
`ChildExecutionFailedError` (`cause`, `childExecutionId`, `itemIndex`), its own limits wrapped in it;
budgets and cancellation pass through unwrapped (S25).

## Patterns

- *Waves*: `.toParallelAgents(A)` → `.join()` → an action mapping to the next list →
  `.toParallelAgents(B)` — everyone together, step by step, the same short chain for all.
- *A child workflow per item*: each item its own way — no barrier between its steps, its own
  branches, repeats and failure isolation.
- *A child workflow to keep a path shallow*: a branch deeper than 4 levels (`[flow.path-too-deep]`)
  moves into a child.
