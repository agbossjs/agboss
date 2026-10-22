# Workflows — the paths

A workflow is a `@Workflow` class whose `flow` is a list of **paths** (#272, [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)).
A path reads as a sentence — "the start returns the message → the router chooses → the profiler
returns a profile → …": it starts at a source, every transition names the kind of its target, and
what a step gives is written on the edge with `.returns(…)`. The paths hold the whole topology and
the data flow; components declare types only. The flow is checked when the workflow is assembled —
before any model call — and every violation is reported at once. Every block on this page compiles
against the current package, with the `.agboss/types.d.ts` its workflows generate
(`npm run check:docs`).

<!--
```ts file=chat.components.ts
import { Agent, DecidedBy, Router, WorkflowFinish, WorkflowStart } from "agboss";
import { Text, WorkflowStartTextDto, oneOf, optional } from "agboss/dto";

export class ProfileDto {
  @Text({ prompt: "the candidate's profile" })
  summary!: string;
}
export class ResumeMissingDto {
  @Text({ prompt: "why no resume was found", optional: true })
  reason?: string;
}
export class OpeningsDto {
  @Text({ prompt: "the openings found" })
  openings!: string;
}
@WorkflowStart({ name: "intake-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class IntakeWorkflowStart {}
@Agent({ name: "profiler-agent", description: "Reads the resume into a profile", prompt: "Read the resume.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: oneOf(ProfileDto, ResumeMissingDto) })
export class ProfilerAgent {}
@Agent({ name: "scout-agent", description: "Finds openings for the profile", prompt: "Find openings.", model: "moonshotai/kimi-k2.6", input: { profile: optional(ProfileDto) }, output: OpeningsDto })
export class ScoutAgent {}
@WorkflowFinish({ name: "ask-resume-workflow-finish", description: "Asks for a resume", output: ResumeMissingDto })
export class AskResumeWorkflowFinish {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The openings found", output: OpeningsDto })
export class ChatWorkflowFinish {}
@WorkflowFinish({ name: "no-reply-workflow-finish", description: "Ends without a reply", output: WorkflowStartTextDto })
export class NoReplyWorkflowFinish {}
@Router({
  name: "main-router",
  description: "Sends the message to the step that handles it, or ends the execution",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message next.",
  input: { message: WorkflowStartTextDto },
  maxVisits: 3,
  routes: [
    { target: ProfilerAgent, prompt: "The customer sends or changes their resume" },
    { target: ScoutAgent, prompt: "The customer asks for job openings" },
    { target: NoReplyWorkflowFinish, prompt: "Stop without a reply: the message needs no answer" },
  ],
})
export class MainRouter {}
```
-->

## Writing a workflow

<!-- snippet-context
import { oneOf } from "agboss/dto";
import { AskResumeWorkflowFinish, ChatWorkflowFinish, IntakeWorkflowStart, MainRouter, NoReplyWorkflowFinish, OpeningsDto, ProfileDto, ProfilerAgent, ResumeMissingDto, ScoutAgent } from "./chat.components.js";
-->

```ts file=chat.workflow.ts
import { Workflow, caseOf, route, router, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

@Workflow({
  name: "chat-workflow",
  version: "1.0.0",
  flow: [
    // MainRouter is reached from the start and from the profiler → it is continued in its own path
    start(IntakeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter),

    router(MainRouter)
      .chooseOne(
        route(ProfilerAgent)
          .returns(oneOf(ProfileDto, ResumeMissingDto)) // its output, then one case per variant
          .switch(
            caseOf(ProfileDto)
              .toRouter(MainRouter), // the loop is visible: back to the router
            caseOf(ResumeMissingDto)
              .toFinish(AskResumeWorkflowFinish),
          ),
        route(ScoutAgent)
          .returns(OpeningsDto)
          .toFinish(ChatWorkflowFinish),
        route(NoReplyWorkflowFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 5,
  maxSteps: 8,
})
export class ChatWorkflow {} // money: the application's @Budgets (FinOps → Budgets)
```

The components behind it declare types only — what they read (`input`, by field) and what they
give (`output`); the router lists its targets with the text Jev chooses by:

```ts no-check: a fragment — the components are defined in the page's hidden components file
@Agent({
  name: "profiler-agent",
  description: "Reads the resume into a profile",
  prompt: "Read the resume.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: oneOf(ProfileDto, ResumeMissingDto), // answered through answer tools
})
export class ProfilerAgent {}

@Router({
  name: "main-router",
  description: "Sends the message to the step that handles it, or ends the execution",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message next.",
  input: { message: WorkflowStartTextDto }, // what the router decides on
  maxVisits: 3,
  routes: [
    { target: ProfilerAgent, prompt: "The customer sends or changes their resume" },
    { target: ScoutAgent, prompt: "The customer asks for job openings" },
    { target: NoReplyWorkflowFinish, prompt: "Stop without a reply: the message needs no answer" },
  ],
})
export class MainRouter {}
```

## The grammar

| Part | |
| --- | --- |
| A line is a path | it starts with its source — `start(S)`, or `agent(X)` / `router(R)` / `action(A)` / `workflow(W)` for a node reached from two or more places — then goes on with steps. The kind of every source and target is checked by the compiler (`agent(MainRouter)` does not compile) |
| `.returns(…)` | `start(S).returns(InputDto)` — a start returns its input; after any other step, what the component's `output` gives — one value per `.returns`, several (a start's map of fields) as a chain `.returns(A).returns(optional(B))` in any order; none after a step without `output`. `{ about: T }` beside one class or a list says what the value is about ([Path scope](Path-scope)). Checked by the compiler against the generated types |
| Transitions | `.toAgent(X)`, `.toRouter(R)`, `.toAction(A)`, `.toFinish(F)`, `.toWorkflow(W)` (a child workflow, #263) — each names its target's kind |
| A child workflow | `.toWorkflow(W)` / `route(W)` — one child; `.toParallelWorkflows(W, { maxConcurrency, maxItems })` — one child per item, joined; the child's start chosen per edge by class, its result `.returns(XDto)` or `.returns(oneOf(…)).switch(…)` with one case per finish output class. At run time a child is an execution of its own (its id, steps, no history) inside its parent's checkpoint and budgets; its uncaught failure is the parent's `ChildExecutionFailedError`. See [Workflow as a step](Workflow-as-a-step) |
| A router's choice | `.toRouter(R).chooseOne(route(A)…, route(B)…, route(F))` (or `router(R).chooseOne(…)` in its own path): exactly the router's `routes` (`[router.routes-mismatch]`), each `route(…)` continued to its end. How to choose stays in `@Router({ routes: [{ target, prompt }] })` ([Routers](Routers)) |
| Branching by result | `.returns(oneOf(ADto, BDto)).switch(caseOf(ADto)…, caseOf(BDto)…)` after a step with a `oneOf` output — exhaustive (`[flow.switch-not-exhaustive]`, `[flow.switch-unknown-case]`); `caseOf(ADto, { about: T })` says what that variant is about, never `.returns(oneOf(…), { about })` |
| Errors | `.onError(ErrorClass, toAction(…)… \| toAgent(…)… \| toRouter(…)… \| toWorkflow(W)… \| toFinish(F))` right after the step that throws, before its `.returns(…)` — a side path may start with a child workflow (#263 S85, [Workflow as a step](Workflow-as-a-step#a-child-as-an-error-handler-s85)); see [Rollback](Rollback) |
| Parallel launch | `.toParallelAgents(A, B, B, { maxConcurrency })` / `.toParallelActions(…)` (#273): each listed target runs once, a repeat is a copy; agents only / actions only (another kind does not compile); one target right after `.returns(listOf(XDto))` runs once per item, `{ maxItems }` required. See [Parallel launches](#parallel-launches) |
| Join | a launch is followed by `.join()` (a path that stops at a launch does not compile), then `.onJoinError(ErrorClass, side path)` — never `.onError` — then `.join().returns(…)`: one value per class the branches give, checked against the generated `JoinOutputs` |
| One way in → inline | a node reached from one place is continued right there (also inside `route(…)`, `caseOf(…)` and `.onError(…)`); an own path for it → `[flow.single-entry-own-path]` |
| Two or more ways in → own path | a non-terminal node reached from several places is continued in its own path (`agent(ReviewerAgent)…`), every path into it ends at it; inline → `[flow.shared-node-inline]` |
| Finishes are terminal | `.toFinish(F)` / `route(F)` — always inline, from any number of places |
| One class = one node | a class mentioned again is the same node (loops, merges); two stages are two classes sharing an options const (`@Agent({ ...reviewerAgentOptions, name: "final-reviewer-agent" })`) — `[flow.continuation-twice]` |
| Position never carries meaning | paths, routes and cases can be reordered without changing the graph; only the order of steps inside a path is a sequence |
| One call per line | a path reads as its steps: `start(S)` / `.returns(…)` / `.toFinish(F)`, each call on its own line, `route(X)` / `.toFinish(F)` inside a choice too (#289). In the repo `*.workflow.ts` modules and the flow fixtures are formatted by `make fmt` (`node scripts/format-flows.mjs`) instead of Prettier and checked by ESLint (`@stylistic/newline-per-chained-call`, `ignoreChainWithDepth: 1`); the docs' flow snippets by `npm run check:docs`; `agboss create` / `agboss generate` write workflow modules this way |

## A node reached from two places

<!--
```ts file=offer.components.ts
import { Action, Agent, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { Flag, Text, oneOf } from "agboss/dto";

export class ShortlistDto {
  @Text({ prompt: "the shortlisted candidates" })
  candidates!: string;
}
export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}
export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}
export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
export class OfferSentDto {
  @Flag({ prompt: "the offer was delivered" })
  delivered!: boolean;
}
@WorkflowStart({ name: "offer-workflow-start", description: "A shortlist", input: ShortlistDto })
export class OfferWorkflowStart {}
@Agent({ name: "draft-agent", description: "Drafts the offer", prompt: "Draft the offer.", model: "moonshotai/kimi-k2.6", input: { shortlist: ShortlistDto }, output: OfferDraftDto })
export class DraftAgent {}
@Agent({ name: "reviewer-agent", description: "Reviews the draft", prompt: "Review the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto }, output: oneOf(ChangesRequestedDto, DraftApprovedDto) })
export class ReviewerAgent {}
@Agent({ name: "editor-agent", description: "Rewrites the draft by the review notes", prompt: "Rewrite the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto, changes: ChangesRequestedDto }, output: OfferDraftDto, maxVisits: 2 })
export class EditorAgent {}
@Action({ name: "notify-recruiter-action", description: "Tells the recruiter the offer failed", input: { draft: OfferDraftDto } })
export class NotifyRecruiterAction implements ActionHandler<NotifyRecruiterAction> {
  async execute(input: InputOf<NotifyRecruiterAction>): Promise<void> {
    await Promise.resolve(input.draft.value.text);
  }
}
@Action({ name: "send-offer-action", description: "Sends the approved offer", input: { draft: OfferDraftDto }, output: OfferSentDto })
export class SendOfferAction implements ActionHandler<SendOfferAction> {
  execute(input: InputOf<SendOfferAction>): Promise<OutputOf<SendOfferAction>> {
    return Promise.resolve({ delivered: input.draft.value.text.length > 0 });
  }
}
@WorkflowFinish({ name: "offer-failed-workflow-finish", description: "No offer", output: OfferDraftDto })
export class OfferFailedWorkflowFinish {}
@WorkflowFinish({ name: "offer-sent-workflow-finish", description: "The offer was sent", output: OfferSentDto })
export class OfferSentWorkflowFinish {}
```
-->

<!-- snippet-context
import { Workflow, VisitsLimitExceededError, agent, caseOf, oneOf, start, toAction } from "agboss";
import { ChangesRequestedDto, DraftAgent, DraftApprovedDto, EditorAgent, NotifyRecruiterAction, OfferDraftDto, OfferFailedWorkflowFinish, OfferSentDto, OfferSentWorkflowFinish, OfferWorkflowStart, ReviewerAgent, SendOfferAction, ShortlistDto } from "./offer.components.js";
-->

```ts
@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewerAgent), // every path into the reviewer ends at it

    agent(ReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
          .toAgent(EditorAgent) // maxVisits: 2 — the third edit is refused before its model call
          .onError(
            VisitsLimitExceededError,
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish), // no output → no .returns
          )
          .returns(OfferDraftDto)
          .toAgent(ReviewerAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendOfferAction)
          .returns(OfferSentDto)
          .toFinish(OfferSentWorkflowFinish),
      ),
  ],
})
export class OfferWorkflow {}
```

The limit of a loop sits on the node whose call would be wasted — here the editor, so the last
draft is the last reviewed one. A cycle needs `maxVisits` on at least one of its nodes, a router or
an agent (`[graph.cycle-without-max-visits]`).

## What a node reads: the path's scope

Every `.returns(…)` puts a value on the path — its **scope** ([Path scope](Path-scope)). A node's
`input` fields are filled from it by type (`draft: OfferDraftDto` reads the latest `OfferDraftDto`
on the path, from whoever produced it); a field no path brings fails assembly
(`[input.missing-on-path]`, naming the shortest path that lacks it), `optional(Dto)` may be absent.
An agent gets them in its **input message** — one block per field, `### draft (from editor-agent)`
and the value as JSON — after its instructions, so the system prompt stays the same between runs
and caches ([Agents](Agents)). An agent without `input` and `output` is a **text agent**: it reads
the message (`WorkflowStartTextDto`) and answers text, which only a `WorkflowFinishTextDto` finish
takes (`[flow.text-agent-target]`).

An **action** (`@Action`, code without a model) gets its fields, each as `{ value, producer }`
(`producer`: the class that gave it) — and nothing else; the execution it runs in comes through
`deps: [ExecutionContext]` ([Components](Components#the-execution-context)).

An action that changes the world may declare its undo (#339): `compensateWith: UndoAction` — an
ordinary `@Action` reading only what the path holds right after it — and `committedBy:
CommitAction`, the action after which nothing undoes it (without it, a finish commits it). A side
path after it then reaches a finish only through the undo, newest first; `agboss check` proves it
([Rollback](Rollback)).

<!-- snippet-context
import { Action, Workflow, WorkflowFinish, WorkflowStart, start, type ActionHandler, type InputOf } from "agboss";
import { OfferDraftDto } from "./offer.components.js";
// @snippet
@WorkflowStart({ name: "audit-workflow-start", description: "A draft", input: OfferDraftDto })
export class AuditWorkflowStart {}
@WorkflowFinish({ name: "audited-workflow-finish", description: "Logged", output: OfferDraftDto })
export class AuditedWorkflowFinish {}
@Workflow({ name: "audit-workflow", version: "1.0.0", flow: [start(AuditWorkflowStart).returns(OfferDraftDto).toAction(AuditLogAction).toFinish(AuditedWorkflowFinish)] })
export class AuditWorkflow {}
-->

```ts
@Action({ name: "audit-log-action", description: "Writes the draft to the audit log", input: { draft: OfferDraftDto } })
export class AuditLogAction implements ActionHandler<AuditLogAction> {
  async execute(input: InputOf<AuditLogAction>): Promise<void> {
    await Promise.resolve(`${input.draft.producer.name}: ${input.draft.value.text}`);
  }
}
```

## Parallel launches

Several steps at once are a launch and its join (#273). The launch lists its targets — agents, or
actions — and the join names what they give; the next step reads those values from the scope by
type, like any other.

<!-- snippet-context
import { Action, Agent, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { Flag, Integer, Text, WorkflowStartTextDto, listOf } from "agboss/dto";

export class CompanyDto {
  @Text({ prompt: "the company's name" })
  name!: string;
}
export class CompanyCheckDto {
  @Flag({ prompt: "whether the company passed" })
  passed!: boolean;
}
export class RankingDto {
  @Text({ prompt: "the companies, best first" })
  order!: string;
}
export class PaymentDto {
  @Integer({ prompt: "the amount in whole dollars" })
  amount!: number;
}
@WorkflowStart({ name: "screening-workflow-start", description: "What to look for", input: WorkflowStartTextDto })
export class ScreeningWorkflowStart {}
@WorkflowStart({ name: "checkout-workflow-start", description: "The payment", input: PaymentDto })
export class CheckoutWorkflowStart {}
@Agent({ name: "screening-agent", description: "Finds companies", prompt: "Find them.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: listOf(CompanyDto) })
export class ScreeningAgent {}
@Agent({ name: "company-check-agent", description: "Checks one company", prompt: "Check it.", model: "moonshotai/kimi-k2.6", input: { company: CompanyDto }, output: CompanyCheckDto })
export class CompanyCheckAgent {}
@Agent({ name: "ranker-agent", description: "Ranks", prompt: "Rank.", model: "moonshotai/kimi-k2.6", input: { checks: listOf(CompanyCheckDto) }, output: RankingDto })
export class RankerAgent {}
@WorkflowFinish({ name: "ranking-workflow-finish", description: "The ranking", output: RankingDto })
export class RankingWorkflowFinish {}
@Action({ name: "send-receipt-action", description: "Sends the receipt", input: { payment: PaymentDto } })
export class SendReceiptAction {
  async execute(): Promise<void> {}
}
@Action({ name: "update-crm-action", description: "Updates the CRM", input: { payment: PaymentDto } })
export class UpdateCrmAction {
  async execute(): Promise<void> {}
}
@WorkflowFinish({ name: "payment-workflow-finish", description: "The payment", output: PaymentDto })
export class PaymentWorkflowFinish {}
// @snippet
@Workflow({ name: "launches-workflow", version: "1.0.0", flow: launchPaths, maxSteps: 60 })
export class LaunchesWorkflow {}
-->

```ts
export const launchPaths = [
  // one agent per item of a list: at most 3 at once, the first 50 items
  start(ScreeningWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(ScreeningAgent)
    .returns(listOf(CompanyDto))
    .toParallelAgents(CompanyCheckAgent, { maxConcurrency: 3, maxItems: 50 })
    .join()
    .returns(listOf(CompanyCheckDto)) // one value per item, in the list's order
    .toAgent(RankerAgent)
    .returns(RankingDto)
    .toFinish(RankingWorkflowFinish),

  // side effects at once: actions without output give the join nothing to name
  start(CheckoutWorkflowStart)
    .returns(PaymentDto)
    .toParallelActions(SendReceiptAction, UpdateCrmAction)
    .join()
    .toFinish(PaymentWorkflowFinish), // reads PaymentDto from the path
] as const;
```

| Rule | |
| --- | --- |
| What the join gives | one value per class: `XDto` for an agent listed once, `listOf(XDto)` for copies of one agent, for two agents with one `output` and for a per-item launch; `optional(XDto)` for a branch whose router route is `SpawnPolicy.OnDemand` or `FailurePolicy.Skip` ([Routing patterns](Advanced-Routing)); nothing for an action without `output`. `.join().returns(…)` names them as a chain in any order — `[flow.returns-mismatch]` otherwise; the generated `JoinOutputs` types it (keyed by the launch as written: `toParallelAgents(researcher-agent, critic-agent, critic-agent)`, `support-router.toParallelAgents(…)`, `toParallelAgents(company-check-agent) per item`) |
| What a branch sees | the scope at the launch — plus, in a per-item run, its item as the latest single `XDto` (its target reads an `XDto` field: `[launch.item-not-read]`, also a compile error through the generated types). Its siblings' values only after the join ([Path scope → Parallel branches](Path-scope#parallel-branches)) |
| Per item | one target right after `.returns(listOf(XDto))` — the list the chain carries, never one looked up in the scope; `{ maxItems }` is required (`[launch.max-items-required]`) and only there (`[launch.max-items-without-list]`); a longer list is truncated, never an error |
| A branch is one step | its join continues it: a launched class continued elsewhere is `[launch.branch-continued]`. A chain of steps per item is a child workflow: `.toParallelWorkflows(W, { maxItems })` ([Workflow as a step](Workflow-as-a-step)) |
| Several of one class | a single field reading a class the join gives as a list is `[input.several-on-path]` — declare `listOf(XDto)` |
| Steps | the fewest steps count the copies of the agents that always run (`Always` + `FailFast`), never a per-item run; the worst case of one call counts every copy and `maxItems` runs, capped by `maxSteps` |
| Errors | a branch's own failure is a `StepFailedError` (`step.failed`, its own code, above `step.agent`, `step.action`, `step.router`, `step.guard`) naming the step — `component`, `nodeId` (`critic-agent#2` for a copy), `visitNumber`, `itemIndex`; an action's exception is `ActionFailedError` with the original as `cause` ([Parallel launches at run time](#parallel-launches-at-run-time)) |

### Parallel launches at run time

Each branch of a launch is one LangGraph `Send` of one superstep; the launch's join is a node of
its own, run once after every branch ended (#273 PR 2).

| What happens | |
| --- | --- |
| Launch id | `${executionId}:${nodeId}:${visitNumber}` of the launching step — a launch inside a loop has a new id each pass, and its join reads only its own branches' records |
| `maxConcurrency` | a sliding window, not waves: a branch takes a slot when it starts and frees it when it ends, fails, is cancelled — or pauses, so a paused branch never holds a slot. With 50 items and `maxConcurrency: 3`, a new run starts as soon as one ends. Without it, every branch runs at once |
| Order | the join's lists are in listed order (copies) or the items' order — never the order the branches finished in; replays and tests are deterministic |
| Copies | a target listed twice runs twice: `critic-agent#1`, `critic-agent#2` in `result.path`, traces and observer events; `executionContext.step.copyNumber` is 1, 2 (1 for a target listed once); every copy is the same visit of its node (the launch's `visitNumber`) with its own idempotency key, its node id `critic-agent#2` |
| Per item | the first `maxItems` items of the list, in its order; the rest are dropped without an error and the drop is visible: `result.launches` (`{ launch, items: 200, taken: 50, branches }`), a trace entry "launch items truncated" and `onLaunchItemsTruncated` ([Observability](Observability)). Each run's `step.itemIndex` is its item's index (from 0) and its idempotency key `${executionId}:${nodeId}:${visitNumber}:${itemIndex}` — one `visitNumber` for every item of the launch; an empty list launches nothing and the join gives `[]` at once |
| Limits | each branch counts against the execution's `maxSteps` (an agent's run is a step), its node's `maxVisits` (one launch is one visit of its node, however many copies or items — those are bounded by the listed targets and `maxItems`) and the money limits (with the spend of the siblings that already ended); a limit reached in a branch fails it like any failure |
| Cancel | `app.cancel` (or the caller's signal) during a launch cancels the whole execution: every running branch is aborted and the call rejects with `ExecutionCancelledError` — never a branch outcome, never `Skip`ped, never taken by `.onJoinError(…)` (S21) |
| `FailFast` | a failed branch aborts the launch: running siblings see their signal (`executionContext.signal`) abort, waiting ones never start — both end `BranchStatus.Cancelled`. Their spend still counts |
| The join | every branch finished (or dropped out) → its values go into the scope at once, one outdating cascade; a branch failed → the most specific `.onJoinError(E, …)` by the error's class and cause chain (`.onJoinError(ItemFailedError, …)` takes the domain error inside an `ActionFailedError`); none → the execution fails with the branch's error as it was thrown |
| Pause and recovery | LangGraph keeps each finished branch's writes: on `app.resume` only the paused branch goes on, and after a crash the instance that takes the tree over ([Several instances](Several-instances)) runs only the branches that had not ended |
| `result.launches` | one `LaunchRecord` per joined launch, in order: `launch` (its id), `items`, `taken` (a router's `OnDemand` "no" is left out), `branches` — each `{ nodeId, copyNumber, itemIndex?, status: BranchStatus.Finished \| Failed \| Skipped \| Cancelled, error? }` |

A router before a launch decides only its `OnDemand` routes; its `Always` ones always run
([Routing patterns → A router decides who is launched](Advanced-Routing#6-a-router-decides-who-is-launched)).

### Quorums

A launch of agents may be joined by a quorum instead of `.join()` (#279, [Parallel](Parallel)):
`.joinQuorum({ min, max, deadline })` goes on with the counted answers, `.joinQuorumGroups(group(A,
B).priority(1).returns(…).to…(…), …, { deadline })` with the first complete group, on that group's
own path. `@Arbiter`s attached with `.acceptedBy(X)` (an AND in path order; `anyOf(X, Y)` the first
that accepts) decide which answers count. After `.joinQuorum({ min })` with `min` below the agents
launched a single answer is `optional(XDto)` in `.returns(…)` — a compile error and
`[flow.quorum-return-not-optional]` otherwise; a repeated class stays `listOf(XDto)` in every form.
At run time the quorum is decided as answers arrive: once it is fixed the rest of the launch is
cancelled, only counted answers enter the path scope (in counting order), and a quorum not reached
is `QuorumNotReachedError` into `.onJoinError(…)` — [Parallel → At run time](Parallel#at-run-time).

## Generated types

`agboss check` (on the application of `package.json`, #268) loads the workflows (transpile-only, a stale file
never blocks it) and writes `.agboss/types.d.ts`: the tables that type `.returns(…)` against each
component's `output`, `InputOf<X>` / `OutputOf<X>` of every node, and `app.execute(Start, input)` /
`result.output`. A class the types need must be exported (`[types.unexported-class]`); without the
file, `tsc` names the fix (`Missing generated types — run agboss check`). The file is git-ignored;
a generated project writes it on install (`npm run types`) and `agboss generate` refreshes it.

## Assembly rules

Checked by `workflowOf` / `createApp` / `agboss check` before any model call; all violations are
reported together in a `GraphRuleError` with stable codes: names end with their kind and are unique
in the application (`[name.kind-suffix]`, `[graph.duplicate-node-name]`); DTO classes on paths end
with `Dto` (`[dto.name]`); `.returns` matches the output (`[flow.returns-mismatch]`); every input is
on every path (`[input.missing-on-path]`); a router's choice lists its routes; the existing graph
rules — a workflow start exists, no unreachable node, no dead end, nothing after a finish, a cycle
has `maxVisits`; a launch is joined (`[launch.join-required]`), a per-item launch has `maxItems`,
a branch renewing what a sibling read is `[launch.branch-outdates-sibling]`; an edge into a child
workflow enters through one start (`[graph.no-matching-start]`, `[graph.ambiguous-start]`), a side
path that can catch a limit reaches no model (`[graph.limit-handler-uses-model]`). Declared
compensation (#339, [Rollback](Rollback#what-agboss-check-proves)): `compensateWith` / `committedBy`
name `@Action`s that are not themselves and undo nothing (`[action.compensator-not-an-action]`,
`[action.committer-not-an-action]`, `[action.self-compensation]`, `[action.compensator-compensates]`),
the undo reads what is on the path right after its action (`[action.invalid-compensator-input]`), a
side path runs the open undo actions newest first (`[flow.uncompensated-action]`,
`[flow.compensation-out-of-order]`) and, with `committedBy`, every path runs the committer or the
undo (`[flow.uncommitted-action]`). A path nested more
than 4 levels deep is a warning (`[flow.path-too-deep]`), as is a per-item child that cannot fail
softly (`[graph.child-without-failure-finish]`) and a committer no path from its action reaches
(`[flow.committer-unreachable]`) — errors under `--strict`.

## Testing

A workflow is tested end to end with scripted models — no network ([Testing](Testing)):

<!-- snippet-context
import { ChatWorkflow } from "./chat.workflow.js";
import { ChatWorkflowFinish, IntakeWorkflowStart, MainRouter, OpeningsDto, ScoutAgent } from "./chat.components.js";
-->

```ts
import { expect } from "vitest";
import { replyWith, routeTo, testWith } from "agboss/testing";
import { Application, EmptyEnvironment } from "agboss";

@Application({ name: "chat-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [ChatWorkflow] })
class ChatApplication {}

const test = testWith(ChatApplication); // an application, never the workflow itself

test("a question about openings goes to the scout", async ({ app, mockLlm }) => {
  mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
  mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "Backend at Acme" }));

  const result = await app.execute(IntakeWorkflowStart, { text: "any backend jobs?" });

  expect(result).toFollowPath([IntakeWorkflowStart, MainRouter, ScoutAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, { openings: "Backend at Acme" });
});
```

## Not in the core yet

Quorums (#279, [Parallel](Parallel)) and child workflows (#263,
[Workflow as a step](Workflow-as-a-step)) run; recursion (`ThisWorkflow`, `maxDepth`) is #264. The old
flow DSL (`from(…).next(…)`, `chain`, `catchError`, `batchParallel`, `node`) is gone;
[ADR-0019](ADR-0019-Flow-as-paths-with-path-scope) says why.
