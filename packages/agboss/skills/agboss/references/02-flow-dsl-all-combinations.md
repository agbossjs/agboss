# 02 — The flow DSL: every combination

Read this before writing or changing a `*.workflow.ts` module: its `flow` of paths, branches, loops,
parallel launches, quorums, child workflows, recursion, `.onError` side paths and undo. Which
primitive to pick: `01-composition-and-architecture.md`; the component classes:
`03-components-di-and-lifecycle.md`; every `[rule.code]` with a fix: `11-cli-studio-and-error-catalog.md`.

Every block below compiles with its generated types. Each class is a block of its own, at its path
in the project (`file=` above it): DTOs in `dto/`, a workflow with its starts and finishes in
`workflows/<w>/`, an agent in `agents/<n>/`, and each recipe in its own domain folder (`src/ticket/`,
`src/credit/`, …). After you change a path, run
`npx agboss check` (it rewrites `.agboss/types.d.ts` and reports every rule at once) and read the
result with `npx agboss describe`.

## The grammar at a glance

A workflow's `flow` is a list of **paths**. A path starts at a **source**, goes through **steps**,
and ends at a finish (or at a node that has its own path). Write **one call per line** — the gate's
`@stylistic/newline-per-chained-call` fails `start(A).returns(B)` on one line.

| Form                                                                                  | What it says                                                                               | Rules it can hit                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `start(S)`                                                                            | where an execution begins (a `@WorkflowStart`)                                             | `[graph.no-workflow-start]`, `[graph.unreachable-node]`                                                      |
| `agent(X)` / `router(R)` / `action(A)` / `workflow(W)`                                | the own path of a node reached from two or more places, written once                       | `[flow.shared-node-inline]`, `[flow.single-entry-own-path]`                                                  |
| `.returns(XDto)`                                                                      | what the step before put on the path (its scope); after `start(S)` its input               | `[flow.returns-mismatch]`, `[flow.unused-output]`                                                            |
| `.returns(A).returns(optional(B))`                                                    | several values of one step (a start's map of fields, a join), any order                    | `[flow.returns-mismatch]`                                                                                    |
| `.returns(XDto, { about: YDto })`                                                     | in a cycle: what the value is an answer about                                              | `[io.ambiguous-cycle]`, `[io.ambiguous-about]`, `[io.about-on-start]`                                        |
| `.toAgent(X)` `.toAction(A)` `.toRouter(R)` `.toWorkflow(W)` `.toFinish(F)`           | the next step, by its kind (another kind does not compile)                                 | `[graph.wrong-kind]`, `[graph.dead-end]`, `[graph.next-after-workflow-finish]`                               |
| `.toRouter(R).chooseOne(route(X)…, …)`                                                | the router's choice: exactly one `route(…)` per `@Router` route, each continued to its end | `[router.routes-mismatch]`, `[router.duplicate-route]`, `[graph.choose-from-non-router]`                     |
| `.returns(oneOf(A, B)).switch(caseOf(A)…, caseOf(B)…)`                                | a branch per variant of a `oneOf` output; `caseOf(A, { about: T })` in a cycle             | `[flow.switch-not-exhaustive]`, `[flow.switch-unknown-case]`                                                 |
| `.onError(E, side path)`                                                              | right after the step that throws (before its `.returns`): what happens when it throws `E`  | `[flow.duplicate-error-handler]`, `[graph.limit-handler-uses-model]`, `[flow.uncompensated-action]`          |
| side-path starters `toAction` `toAgent` `toRouter` `toWorkflow` `toFinish`            | the first step of a side path (functions, not methods)                                     | as for the steps                                                                                             |
| `.toParallelAgents(A, B, B, { maxConcurrency })` / `.toParallelActions(…)`            | a launch: each listed target runs once, a repeat is a copy                                 | `[launch.join-required]`, `[launch.branch-continued]`                                                        |
| `.returns(listOf(XDto)).toParallelAgents(X, { maxItems })`                            | one run per item of the list                                                               | `[launch.max-items-required]`, `[launch.item-not-read]`, `[launch.max-items-without-list]`                   |
| `.join()` → `.onJoinError(E, …)` → `.returns(…)`                                      | where a launch's values meet; a failed branch's side path                                  | `[flow.returns-mismatch]`, `[launch.branch-outdates-sibling]`                                                |
| `.acceptedBy(X)` / `.acceptedBy(anyOf(X, Y))` → `.joinQuorum({ min, max, deadline })` | count the accepted answers instead of waiting for all                                      | `[flow.quorum-impossible]`, `[flow.quorum-return-not-optional]`, `[arbiter.*]`                               |
| `.joinQuorumGroups(group(A, B).priority(1)…, …, { deadline })`                        | the first complete group (by priority) continues its own path                              | `[flow.quorum-impossible]`, `[flow.returns-mismatch]`                                                        |
| `.toWorkflow(W)` / `route(W)` / `.toParallelWorkflows(W, { maxItems })`               | a child workflow: one, chosen by a router, or one per item                                 | `[graph.no-matching-start]`, `[graph.ambiguous-start]`, `[graph.child-without-failure-finish]`               |
| `ThisWorkflow` + `@Workflow({ maxDepth })`                                            | the workflow launches itself                                                               | `[graph.recursion-without-depth]`, `[graph.recursion-without-exit]`, `[graph.mutual-recursion]`              |
| `@Action({ compensateWith, committedBy })`                                            | the action's undo and its commit point; side paths must run the undo                       | `[action.*]`, `[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`, `[flow.uncommitted-action]` |

The wrappers (`agboss`, also re-exported by `@agboss/core/dto`): `listOf(XDto)`, `oneOf(A, B)`,
`optional(XDto)`, `historyOf(XDto, { limit })` (an input only), `variant(XDto, value)` (tests).

Placement rules that hold everywhere:

- **One class is one node.** A class mentioned again is the same node (a loop, a merge). Two stages
  that look alike are two classes (`[flow.continuation-twice]`).
- **A node reached from one place is continued inline**; one reached from two or more places has its
  own path — `agent(X)…`, `action(A)…` — and every path into it ends at it.
- **Finishes are terminal and always inline**: `.toFinish(F)` or `route(F)`, from any number of places.
- **Position never carries meaning**: paths, routes and cases can be reordered.

## 1. A straight path, a start with several fields

A start's input is a DTO, a `listOf(…)` or a map of fields; `start(S)` returns each field with one
`.returns(…)`. A node reads its `input` fields from the scope by class — never by position. An action
gets each field as `{ producer, value }`.

```ts file=src/ticket/dto/ticket.dto.ts
import { Text } from "@agboss/core/dto";

export class TicketDto {
  @Text({ prompt: "what the customer wrote" })
  body!: string;
}
```

```ts file=src/ticket/dto/customer.dto.ts
import { Text } from "@agboss/core/dto";

export class CustomerDto {
  @Text({ prompt: "the customer's plan" })
  plan!: string;
}
```

```ts file=src/ticket/dto/triage.dto.ts
import { Flag, OneOf } from "@agboss/core/dto";

export class TriageDto {
  @OneOf({ values: ["billing", "bug", "other"], prompt: "the ticket's queue" })
  queue!: "billing" | "bug" | "other";

  @Flag({ prompt: "whether the ticket is urgent" })
  isUrgent!: boolean;
}
```

```ts file=src/ticket/dto/ticket-filed.dto.ts
import { Text } from "@agboss/core/dto";

export class TicketFiledDto {
  @Text({ prompt: "the filed ticket's id" })
  ticketId!: string;
}
```

```ts file=src/ticket/workflows/ticket/ticket.workflow-start.ts
import { WorkflowStart, optional } from "@agboss/core";
import { CustomerDto } from "../../dto/customer.dto.js";
import { TicketDto } from "../../dto/ticket.dto.js";

@WorkflowStart({
  name: "ticket-workflow-start",
  description: "A ticket, and the customer when known",
  input: { ticket: TicketDto, customer: optional(CustomerDto) },
})
export class TicketWorkflowStart {}
```

```ts file=src/ticket/agents/ticket-triage/ticket-triage.agent.ts
import { Agent, optional } from "@agboss/core";
import { CustomerDto } from "../../dto/customer.dto.js";
import { TicketDto } from "../../dto/ticket.dto.js";
import { TriageDto } from "../../dto/triage.dto.js";

@Agent({
  name: "ticket-triage-agent",
  description: "Sorts the ticket into a queue",
  prompt: "Sort the ticket into a queue; urgent when the customer cannot work.",
  model: "moonshotai/kimi-k2.6",
  input: { ticket: TicketDto, customer: optional(CustomerDto) },
  output: TriageDto,
})
export class TicketTriageAgent {}
```

```ts file=src/ticket/actions/file-ticket.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { TicketFiledDto } from "../dto/ticket-filed.dto.js";
import { TicketDto } from "../dto/ticket.dto.js";
import { TriageDto } from "../dto/triage.dto.js";

@Action({
  name: "file-ticket-action",
  description: "Files the ticket in its queue",
  input: { ticket: TicketDto, triage: TriageDto },
  output: TicketFiledDto,
  deps: [ExecutionContext],
})
export class FileTicketAction implements ActionHandler<FileTicketAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<FileTicketAction>): Promise<OutputOf<FileTicketAction>> {
    const { queue } = input.triage.value; // { producer, value }: the value and who made it
    return Promise.resolve({ ticketId: `${queue}-${this.executionContext.step.idempotencyKey}` });
  }
}
```

```ts file=src/ticket/workflows/ticket/ticket-filed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { TicketFiledDto } from "../../dto/ticket-filed.dto.js";

@WorkflowFinish({
  name: "ticket-filed-workflow-finish",
  description: "The filed ticket",
  output: TicketFiledDto,
})
export class TicketFiledWorkflowFinish {}
```

```ts file=src/ticket/workflows/ticket/ticket.workflow.ts
import { Workflow, optional, start } from "@agboss/core";
import { FileTicketAction } from "../../actions/file-ticket.action.js";
import { TicketTriageAgent } from "../../agents/ticket-triage/ticket-triage.agent.js";
import { CustomerDto } from "../../dto/customer.dto.js";
import { TicketFiledDto } from "../../dto/ticket-filed.dto.js";
import { TicketDto } from "../../dto/ticket.dto.js";
import { TriageDto } from "../../dto/triage.dto.js";
import { TicketFiledWorkflowFinish } from "./ticket-filed.workflow-finish.js";
import { TicketWorkflowStart } from "./ticket.workflow-start.js";

@Workflow({
  name: "ticket-workflow",
  version: "1.0.0",
  flow: [
    start(TicketWorkflowStart)
      .returns(TicketDto) // a start's map of fields: one .returns per field, any order
      .returns(optional(CustomerDto))
      .toAgent(TicketTriageAgent)
      .returns(TriageDto)
      .toAction(FileTicketAction) // reads ticket (from the start) and triage (from the agent)
      .returns(TicketFiledDto)
      .toFinish(TicketFiledWorkflowFinish), // a finish without finish(): hands back its output class
  ],
  maxSteps: 2,
})
export class TicketWorkflow {}
```

- `.returns(…)` must say exactly what the step gives (`[flow.returns-mismatch]`: `ticket-triage-agent
gives TriageDto — write .returns(TriageDto) after it`); a step without `output` has no `.returns`.
- A value nobody reads is `[flow.unused-output]`; a required field no path brings is
  `[input.missing-on-path]`; an `optional(…)` field no path ever brings is `[input.never-produced]`.
- Two fields of one class in one node read the same value: `[flow.ambiguous-field]` — read it once,
  or with `historyOf(XDto)` (section 3).

## 2. A router's choice, a node reached from two places

`.toRouter(R).chooseOne(…)` lists one `route(…)` per route of the `@Router` — exactly those
(`[router.routes-mismatch]`). A model router reads its `input` and picks by meaning; a code router's
`route(input)` returns a target, typed by its `routes`. A **text agent** (no `output`) leads only to a
finish whose output is `WorkflowFinishTextDto` (`[flow.text-agent-target]`).

```ts file=src/credit/dto/credit-order.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class CreditOrderDto {
  @Text({ prompt: "the customer's id" })
  customerId!: string;

  @Integer({ prompt: "the order's total in whole dollars", min: 1 })
  total!: number;
}
```

```ts file=src/credit/dto/credit-approval.dto.ts
import { Text } from "@agboss/core/dto";

export class CreditApprovalDto {
  @Text({ prompt: "who approved the order" })
  approvedBy!: string;
}
```

```ts file=src/credit/dto/charge-result.dto.ts
import { Text } from "@agboss/core/dto";

export class ChargeResultDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}
```

```ts file=src/credit/errors/credit-service-unavailable.error.ts


export class CreditServiceUnavailableError extends Error {}
```

```ts file=src/credit/workflows/credit/credit.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "credit-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class CreditWorkflowStart {}
```

```ts file=src/credit/agents/order-intake/order-intake.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

@Agent({
  name: "order-intake-agent",
  description: "Turns the message into an order",
  prompt: "Read the order out of the message.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: CreditOrderDto,
})
export class OrderIntakeAgent {}
```

```ts file=src/credit/agents/credit-question/credit-question.agent.ts
import { Agent } from "@agboss/core";

@Agent({
  name: "credit-question-agent",
  description: "Answers a question about credit terms",
  prompt: "Answer the question about our credit terms in two sentences.",
  model: "moonshotai/kimi-k2.6",
}) // a text agent: no output — it answers text
export class CreditQuestionAgent {}
```

```ts file=src/credit/agents/credit-approval/credit-approval.agent.ts
import { Agent } from "@agboss/core";
import { CreditApprovalDto } from "../../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

@Agent({
  name: "credit-approval-agent",
  description: "Approves a large order",
  prompt: "Approve the order if the customer's history allows it.",
  model: "moonshotai/kimi-k2.6",
  input: { order: CreditOrderDto },
  output: CreditApprovalDto,
})
export class CreditApprovalAgent {}
```

```ts file=src/credit/actions/charge-order.action.ts
import { Action, ExecutionContext, optional } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { ChargeResultDto } from "../dto/charge-result.dto.js";
import { CreditApprovalDto } from "../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../dto/credit-order.dto.js";

@Action({
  name: "charge-order-action",
  description: "Charges the order",
  input: { order: CreditOrderDto, approval: optional(CreditApprovalDto) }, // absent on the small-order path
  output: ChargeResultDto,
  deps: [ExecutionContext],
})
export class ChargeOrderAction implements ActionHandler<ChargeOrderAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<ChargeOrderAction>): Promise<OutputOf<ChargeOrderAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    const approvedBy: string = input.approval?.value.approvedBy ?? "auto";
    return Promise.resolve({ chargeId: `${input.order.value.customerId}:${approvedBy}:${key}` });
  }
}
```

```ts file=src/credit/workflows/credit/credit-answer.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

@WorkflowFinish({ name: "credit-answer-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class CreditAnswerWorkflowFinish {}
```

```ts file=src/credit/workflows/credit/order-charged.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { ChargeResultDto } from "../../dto/charge-result.dto.js";

@WorkflowFinish({ name: "order-charged-workflow-finish", description: "The charge", output: ChargeResultDto })
export class OrderChargedWorkflowFinish {}
```

```ts file=src/credit/workflows/credit/order-held.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

@WorkflowFinish({ name: "order-held-workflow-finish", description: "An order held for later", output: CreditOrderDto })
export class OrderHeldWorkflowFinish {}
```

```ts file=src/credit/routers/credit-desk/credit-desk.router.ts
import { DecidedBy, Router } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CreditQuestionAgent } from "../../agents/credit-question/credit-question.agent.js";
import { OrderIntakeAgent } from "../../agents/order-intake/order-intake.agent.js";

@Router({
  name: "credit-desk-router",
  description: "Sends an order to intake, a question to the answering agent",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message.",
  input: { message: WorkflowStartTextDto },
  maxVisits: 1,
  routes: [
    { prompt: "The message places an order", target: OrderIntakeAgent },
    { prompt: "The message asks about credit terms", target: CreditQuestionAgent },
  ],
})
export class CreditDeskRouter {}
```

```ts file=src/credit/routers/credit-limit/credit-limit.router.ts
import { DecidedBy, Router, route } from "@agboss/core";
import type { InputOf, Route, RouterHandler } from "@agboss/core";
import { ChargeOrderAction } from "../../actions/charge-order.action.js";
import { CreditApprovalAgent } from "../../agents/credit-approval/credit-approval.agent.js";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

const APPROVAL_LIMIT = 1000;

@Router({
  name: "credit-limit-router",
  description: "Sends a large order to approval, charges a small one",
  decidedBy: DecidedBy.Code,
  input: { order: CreditOrderDto },
  routes: [{ target: CreditApprovalAgent }, { target: ChargeOrderAction }],
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  route(input: InputOf<CreditLimitRouter>): Route<CreditLimitRouter> {
    return input.order.value.total > APPROVAL_LIMIT ? CreditApprovalAgent : ChargeOrderAction;
  }
}
```

```ts file=src/credit/workflows/credit/credit.workflow.ts
import { Workflow, action, route, start, toFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ChargeOrderAction } from "../../actions/charge-order.action.js";
import { CreditApprovalAgent } from "../../agents/credit-approval/credit-approval.agent.js";
import { CreditQuestionAgent } from "../../agents/credit-question/credit-question.agent.js";
import { OrderIntakeAgent } from "../../agents/order-intake/order-intake.agent.js";
import { ChargeResultDto } from "../../dto/charge-result.dto.js";
import { CreditApprovalDto } from "../../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";
import { CreditServiceUnavailableError } from "../../errors/credit-service-unavailable.error.js";
import { CreditDeskRouter } from "../../routers/credit-desk/credit-desk.router.js";
import { CreditLimitRouter } from "../../routers/credit-limit/credit-limit.router.js";
import { CreditAnswerWorkflowFinish } from "./credit-answer.workflow-finish.js";
import { CreditWorkflowStart } from "./credit.workflow-start.js";
import { OrderChargedWorkflowFinish } from "./order-charged.workflow-finish.js";
import { OrderHeldWorkflowFinish } from "./order-held.workflow-finish.js";

@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  flow: [
    start(CreditWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(CreditDeskRouter)
      .chooseOne(
        route(OrderIntakeAgent)
          .returns(CreditOrderDto)
          .toRouter(CreditLimitRouter)
          .onError(
            CreditServiceUnavailableError, // route() threw: caught through RouterFailedError's cause
            toFinish(OrderHeldWorkflowFinish),
          )
          .chooseOne(
            route(CreditApprovalAgent)
              .returns(CreditApprovalDto)
              .toAction(ChargeOrderAction), // ends at the shared node
            route(ChargeOrderAction),
          ),
        route(CreditQuestionAgent)
          .toFinish(CreditAnswerWorkflowFinish), // a text agent → a WorkflowFinishTextDto finish
      ),

    // reached from two places (the approval and the limit router): its own path, written once
    action(ChargeOrderAction)
      .returns(ChargeResultDto)
      .toFinish(OrderChargedWorkflowFinish),
  ],
  maxSteps: 6,
})
export class CreditWorkflow {}
```

- A route **to a finish** on a model router is worded as a stop instruction ("Stop and hand it over:
  …"), never "the answer is ready".
- A router that fails fails the run unless an `.onError(…)` right after it takes it: `RouterFailedError`
  (the original as `cause`, so `.onError(CreditServiceUnavailableError, …)` catches it) or
  `RouterDecisionError` (an answer outside its routes; a `RouterFailedError` too, never retried).
- `.onError` stands right after the step, before its `.returns(…)` or `.chooseOne(…)`.
- A model router without `model` takes `defaults.router.model` (`[router.no-model]`); its `input`
  is never empty (`[router.empty-input]`); `spawn` / `failure` on its routes are for launches only
  (`[router.policy-with-choose-one]`).

## 3. A branch by result, a loop, `about`, `historyOf`

An agent with `output: oneOf(A, B)` says which outcome it is; `.returns(oneOf(A, B)).switch(…)` has
one `caseOf(…)` per variant. In a loop whose classes are built from each other the flow says what a
value is **about**, and `historyOf(XDto, { limit })` reads the earlier versions. Every node on a
cycle needs `maxVisits` (`[graph.cycle-without-max-visits]`).

```ts file=src/offer/dto/candidate-shortlist.dto.ts
import { Text } from "@agboss/core/dto";

export class CandidateShortlistDto {
  @Text({ prompt: "the shortlisted candidate" })
  candidate!: string;
}
```

```ts file=src/offer/dto/offer-draft.dto.ts
import { Text } from "@agboss/core/dto";

export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}
```

```ts file=src/offer/dto/changes-requested.dto.ts
import { Text } from "@agboss/core/dto";

export class ChangesRequestedDto {
  @Text({ prompt: "what to change in the draft" })
  notes!: string;
}
```

```ts file=src/offer/dto/draft-approved.dto.ts
import { optional } from "@agboss/core";
import { Text } from "@agboss/core/dto";

export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
```

```ts file=src/offer/dto/offer-sent.dto.ts
import { Text } from "@agboss/core/dto";

export class OfferSentDto {
  @Text({ prompt: "the sent offer's id" })
  offerId!: string;
}
```

```ts file=src/offer/workflows/offer/offer.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { CandidateShortlistDto } from "../../dto/candidate-shortlist.dto.js";

@WorkflowStart({ name: "offer-workflow-start", description: "A shortlisted candidate", input: CandidateShortlistDto })
export class OfferWorkflowStart {}
```

```ts file=src/offer/agents/offer-draft/offer-draft.agent.ts
import { Agent } from "@agboss/core";
import { CandidateShortlistDto } from "../../dto/candidate-shortlist.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-draft-agent",
  description: "Writes the first draft of the offer",
  prompt: "Write the offer for the candidate.",
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: CandidateShortlistDto },
  output: OfferDraftDto,
})
export class OfferDraftAgent {}
```

```ts file=src/offer/agents/offer-reviewer/offer-reviewer.agent.ts
import { Agent, historyOf, oneOf } from "@agboss/core";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../dto/draft-approved.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: "Approve the draft, or say what to change. Compare it with the earlier versions.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: historyOf(OfferDraftDto, { limit: 2 }) }, // { current, previous } — the last two before
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
  maxVisits: 4,
})
export class OfferReviewerAgent {}
```

```ts file=src/offer/agents/offer-editor/offer-editor.agent.ts
import { Agent } from "@agboss/core";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-editor-agent",
  description: "Rewrites the draft as asked",
  prompt: "Rewrite the draft so it meets the requested changes.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto, changes: ChangesRequestedDto },
  output: OfferDraftDto,
  maxVisits: 3,
})
export class OfferEditorAgent {}
```

```ts file=src/offer/actions/send-offer.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { OfferDraftDto } from "../dto/offer-draft.dto.js";
import { OfferSentDto } from "../dto/offer-sent.dto.js";

@Action({
  name: "send-offer-action",
  description: "Sends the approved offer",
  input: { draft: OfferDraftDto },
  output: OfferSentDto,
  deps: [ExecutionContext],
})
export class SendOfferAction implements ActionHandler<SendOfferAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: InputOf<SendOfferAction>): Promise<OutputOf<SendOfferAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return Promise.resolve({ offerId: `${String(input.draft.value.text.length)}:${key}` });
  }
}
```

```ts file=src/offer/actions/notify-recruiter.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { CandidateShortlistDto } from "../dto/candidate-shortlist.dto.js";

@Action({
  name: "notify-recruiter-action",
  description: "Tells the recruiter the offer needs a person",
  input: { shortlist: CandidateShortlistDto },
})
export class NotifyRecruiterAction implements ActionHandler<NotifyRecruiterAction> {
  async execute(input: InputOf<NotifyRecruiterAction>): Promise<void> {
    await Promise.resolve(input.shortlist.value.candidate);
  }
}
```

```ts file=src/offer/workflows/offer/offer-sent.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OfferSentDto } from "../../dto/offer-sent.dto.js";

@WorkflowFinish({ name: "offer-sent-workflow-finish", description: "The sent offer", output: OfferSentDto })
export class OfferSentWorkflowFinish {}
```

```ts file=src/offer/workflows/offer/offer-failed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { CandidateShortlistDto } from "../../dto/candidate-shortlist.dto.js";

@WorkflowFinish({
  name: "offer-failed-workflow-finish",
  description: "The candidate, handed to the recruiter",
  output: CandidateShortlistDto,
})
export class OfferFailedWorkflowFinish {}
```

```ts file=src/offer/workflows/offer/offer.workflow.ts
import { VisitsLimitExceededError, Workflow, agent, caseOf, oneOf, start, toAction } from "@agboss/core";
import { NotifyRecruiterAction } from "../../actions/notify-recruiter.action.js";
import { SendOfferAction } from "../../actions/send-offer.action.js";
import { OfferDraftAgent } from "../../agents/offer-draft/offer-draft.agent.js";
import { OfferEditorAgent } from "../../agents/offer-editor/offer-editor.agent.js";
import { OfferReviewerAgent } from "../../agents/offer-reviewer/offer-reviewer.agent.js";
import { CandidateShortlistDto } from "../../dto/candidate-shortlist.dto.js";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../dto/draft-approved.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";
import { OfferSentDto } from "../../dto/offer-sent.dto.js";
import { OfferFailedWorkflowFinish } from "./offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "./offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "./offer.workflow-start.js";

@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    start(OfferWorkflowStart)
      .returns(CandidateShortlistDto)
      .toAgent(OfferDraftAgent)
      .returns(OfferDraftDto)
      .toAgent(OfferReviewerAgent), // the reviewer is reached from two places: its own path below

    agent(OfferReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
          .toAgent(OfferEditorAgent)
          .onError(
            VisitsLimitExceededError, // the editor's maxVisits spent: a person takes over
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish),
          )
          .returns(OfferDraftDto) // a new draft: the old one and the changes about it are outdated
          .toAgent(OfferReviewerAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendOfferAction)
          .returns(OfferSentDto)
          .toFinish(OfferSentWorkflowFinish),
      ),
  ],
  maxSteps: 12,
})
export class OfferWorkflow {}
```

- **Outdating.** A new value in a slot outdates everything built from the older one: after the editor
  returns a new `OfferDraftDto`, the old draft and the `ChangesRequestedDto` about it are gone from the
  scope. A field that would read an outdated value on some path fails assembly with
  `[input.outdated-on-path]`.
- **`about`.** The reviewer reads the draft and the editor reads the changes: each is built from the
  other, so the analyser cannot tell the direction — `[io.ambiguous-cycle]` until one value says what
  it is about (`caseOf(ChangesRequestedDto, { about: OfferDraftDto })`, or
  `.returns(CritiqueDto, { about: DraftDto })` on a single class). A start's input is about nothing
  (`[io.about-on-start]`); `about` on a value a node reads twice is `[io.ambiguous-about]`.
- **`historyOf(XDto, { limit })`** is `{ current, previous }`, `previous` oldest first, at most
  `limit` (a positive integer, `[input.history-limit]`); it needs a current `XDto` on every path in.
- `caseOf(…)` of a class the step does not give is `[flow.switch-unknown-case]`, a missing variant
  `[flow.switch-not-exhaustive]`; `{ about }` goes on the case, never on `.returns(oneOf(…))`.

## 4. Parallel launches and joins

A launch runs several branches at once; `.join()` is where their values meet. Agents with
`.toParallelAgents(…)`, actions with `.toParallelActions(…)` — never mixed. What the join gives:

| Branches                                                              | `.join().returns(…)`                      |
| --------------------------------------------------------------------- | ----------------------------------------- |
| an agent listed once                                                  | `XDto`                                    |
| copies of one agent (`B, B`), two agents with one `output`            | `listOf(XDto)`                            |
| one target per item (right after `.returns(listOf(ItemDto))`)         | `listOf(XDto)`, in the items' order       |
| a router route that is `SpawnPolicy.OnDemand` or `FailurePolicy.Skip` | `optional(XDto)`                          |
| an action without `output`                                            | nothing: `.join()` goes on with `.to…(…)` |

```ts file=src/review/dto/article-section.dto.ts
import { Text } from "@agboss/core/dto";

export class ArticleSectionDto {
  @Text({ prompt: "the section's title" })
  title!: string;

  @Text({ prompt: "the section's text" })
  body!: string;
}
```

```ts file=src/review/dto/section-review.dto.ts
import { Text } from "@agboss/core/dto";

export class SectionReviewDto {
  @Text({ prompt: "what to fix in the section" })
  notes!: string;
}
```

```ts file=src/review/dto/style-notes.dto.ts
import { Text } from "@agboss/core/dto";

export class StyleNotesDto {
  @Text({ prompt: "notes on style" })
  notes!: string;
}
```

```ts file=src/review/dto/fact-check.dto.ts
import { Flag } from "@agboss/core/dto";

export class FactCheckDto {
  @Flag({ prompt: "whether every claim is supported" })
  isSupported!: boolean;
}
```

```ts file=src/review/dto/section-notes.dto.ts
import { Text } from "@agboss/core/dto";

export class SectionNotesDto {
  @Text({ prompt: "the section reviews, merged" })
  notes!: string;
}
```

```ts file=src/review/dto/review-summary.dto.ts
import { Text } from "@agboss/core/dto";

export class ReviewSummaryDto {
  @Text({ prompt: "what to change, in order" })
  plan!: string;
}
```

```ts file=src/review/workflows/article-review/article-review.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "article-review-workflow-start", description: "An article", input: WorkflowStartTextDto })
export class ArticleReviewWorkflowStart {}
```

```ts file=src/review/workflows/article-review/article-publish.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "article-publish-workflow-start", description: "An article to publish", input: WorkflowStartTextDto })
export class ArticlePublishWorkflowStart {}
```

```ts file=src/review/agents/section-splitter/section-splitter.agent.ts
import { Agent, listOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ArticleSectionDto } from "../../dto/article-section.dto.js";

@Agent({
  name: "section-splitter-agent",
  description: "Splits the article into sections",
  prompt: "Split the article into its sections.",
  model: "moonshotai/kimi-k2.6",
  input: { article: WorkflowStartTextDto },
  output: listOf(ArticleSectionDto),
})
export class SectionSplitterAgent {}
```

```ts file=src/review/agents/section-reviewer/section-reviewer.agent.ts
import { Agent } from "@agboss/core";
import { ArticleSectionDto } from "../../dto/article-section.dto.js";
import { SectionReviewDto } from "../../dto/section-review.dto.js";

@Agent({
  name: "section-reviewer-agent",
  description: "Reviews one section",
  prompt: "Say what to fix in this section.",
  model: "moonshotai/kimi-k2.6",
  input: { section: ArticleSectionDto }, // per item: reads the item's class
  output: SectionReviewDto,
})
export class SectionReviewerAgent {}
```

```ts file=src/review/agents/style-critic/style-critic.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { StyleNotesDto } from "../../dto/style-notes.dto.js";

@Agent({
  name: "style-critic-agent",
  description: "Checks the style",
  prompt: "Note what to change in the style.",
  model: "moonshotai/kimi-k2.6",
  input: { article: WorkflowStartTextDto },
  output: StyleNotesDto,
})
export class StyleCriticAgent {}
```

```ts file=src/review/agents/fact-checker/fact-checker.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { FactCheckDto } from "../../dto/fact-check.dto.js";

@Agent({
  name: "fact-checker-agent",
  description: "Checks the claims",
  prompt: "Check every claim of the article.",
  model: "moonshotai/kimi-k2.6",
  input: { article: WorkflowStartTextDto },
  output: FactCheckDto,
})
export class FactCheckerAgent {}
```

```ts file=src/review/actions/section-notes.action.ts
import { Action, listOf } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { SectionNotesDto } from "../dto/section-notes.dto.js";
import { SectionReviewDto } from "../dto/section-review.dto.js";

@Action({
  name: "section-notes-action",
  description: "Merges the section reviews",
  input: { sections: listOf(SectionReviewDto) },
  output: SectionNotesDto,
})
export class SectionNotesAction implements ActionHandler<SectionNotesAction> {
  execute(input: InputOf<SectionNotesAction>): Promise<OutputOf<SectionNotesAction>> {
    // a list field is one { producer, value } per item
    return Promise.resolve({ notes: input.sections.map((review) => review.value.notes).join("\n") });
  }
}
```

```ts file=src/review/actions/review-summary.action.ts
import { Action, listOf } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { FactCheckDto } from "../dto/fact-check.dto.js";
import { ReviewSummaryDto } from "../dto/review-summary.dto.js";
import { SectionNotesDto } from "../dto/section-notes.dto.js";
import { StyleNotesDto } from "../dto/style-notes.dto.js";

@Action({
  name: "review-summary-action",
  description: "Merges every review into one plan",
  input: { sections: SectionNotesDto, style: StyleNotesDto, facts: listOf(FactCheckDto) },
  output: ReviewSummaryDto,
})
export class ReviewSummaryAction implements ActionHandler<ReviewSummaryAction> {
  execute(input: InputOf<ReviewSummaryAction>): Promise<OutputOf<ReviewSummaryAction>> {
    const isSupported: boolean = input.facts.every((check) => check.value.isSupported);
    const plan: string = [input.style.value.notes, input.sections.value.notes, `facts ok: ${String(isSupported)}`].join("\n");
    return Promise.resolve({ plan });
  }
}
```

```ts file=src/review/actions/archive-article.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@Action({ name: "archive-article-action", description: "Archives the article", input: { article: WorkflowStartTextDto } })
export class ArchiveArticleAction implements ActionHandler<ArchiveArticleAction> {
  async execute(input: InputOf<ArchiveArticleAction>): Promise<void> {
    await Promise.resolve(input.article.value.text.length);
  }
}
```

```ts file=src/review/actions/index-article.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@Action({ name: "index-article-action", description: "Indexes the article for search", input: { article: WorkflowStartTextDto } })
export class IndexArticleAction implements ActionHandler<IndexArticleAction> {
  async execute(input: InputOf<IndexArticleAction>): Promise<void> {
    await Promise.resolve(input.article.value.text.length);
  }
}
```

```ts file=src/review/workflows/article-review/review-summary.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { ReviewSummaryDto } from "../../dto/review-summary.dto.js";

@WorkflowFinish({ name: "review-summary-workflow-finish", description: "The review plan", output: ReviewSummaryDto })
export class ReviewSummaryWorkflowFinish {}
```

```ts file=src/review/workflows/article-review/article-published.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowFinish({ name: "article-published-workflow-finish", description: "The published article", output: WorkflowStartTextDto })
export class ArticlePublishedWorkflowFinish {}
```

```ts file=src/review/workflows/article-review/review-incomplete.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowFinish({
  name: "review-incomplete-workflow-finish",
  description: "The article, unreviewed: a check failed",
  output: WorkflowStartTextDto,
})
export class ReviewIncompleteWorkflowFinish {}
```

```ts file=src/review/workflows/article-review/article-review.workflow.ts
import { StepFailedError, Workflow, listOf, start, toFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ArchiveArticleAction } from "../../actions/archive-article.action.js";
import { IndexArticleAction } from "../../actions/index-article.action.js";
import { ReviewSummaryAction } from "../../actions/review-summary.action.js";
import { SectionNotesAction } from "../../actions/section-notes.action.js";
import { FactCheckerAgent } from "../../agents/fact-checker/fact-checker.agent.js";
import { SectionReviewerAgent } from "../../agents/section-reviewer/section-reviewer.agent.js";
import { SectionSplitterAgent } from "../../agents/section-splitter/section-splitter.agent.js";
import { StyleCriticAgent } from "../../agents/style-critic/style-critic.agent.js";
import { ArticleSectionDto } from "../../dto/article-section.dto.js";
import { FactCheckDto } from "../../dto/fact-check.dto.js";
import { ReviewSummaryDto } from "../../dto/review-summary.dto.js";
import { SectionNotesDto } from "../../dto/section-notes.dto.js";
import { SectionReviewDto } from "../../dto/section-review.dto.js";
import { StyleNotesDto } from "../../dto/style-notes.dto.js";
import { ArticlePublishWorkflowStart } from "./article-publish.workflow-start.js";
import { ArticlePublishedWorkflowFinish } from "./article-published.workflow-finish.js";
import { ArticleReviewWorkflowStart } from "./article-review.workflow-start.js";
import { ReviewIncompleteWorkflowFinish } from "./review-incomplete.workflow-finish.js";
import { ReviewSummaryWorkflowFinish } from "./review-summary.workflow-finish.js";

@Workflow({
  name: "article-review-workflow",
  version: "1.0.0",
  flow: [
    start(ArticleReviewWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SectionSplitterAgent)
      .returns(listOf(ArticleSectionDto))
      .toParallelAgents(SectionReviewerAgent, { maxConcurrency: 3, maxItems: 20 }) // one run per item
      .join()
      .returns(listOf(SectionReviewDto)) // one value per item, in the list's order
      .toAction(SectionNotesAction) // a join goes on with one .to…(…) — never straight into a launch
      .returns(SectionNotesDto)
      .toParallelAgents(StyleCriticAgent, FactCheckerAgent, FactCheckerAgent, { maxConcurrency: 2 })
      .join()
      .onJoinError(
        StepFailedError, // a branch failed (FailFast): the others were cancelled
        toFinish(ReviewIncompleteWorkflowFinish),
      )
      .returns(StyleNotesDto)
      .returns(listOf(FactCheckDto)) // fact-checker-agent ran twice: a list
      .toAction(ReviewSummaryAction)
      .returns(ReviewSummaryDto)
      .toFinish(ReviewSummaryWorkflowFinish),

    // side effects at once: actions without output give the join nothing to name
    start(ArticlePublishWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelActions(ArchiveArticleAction, IndexArticleAction)
      .join() // no .returns
      .toFinish(ArticlePublishedWorkflowFinish), // reads the WorkflowStartTextDto from the path
  ],
  maxSteps: 30, // the worst case: the splitter, 20 section reviews and three critics
})
export class ArticleReviewWorkflow {}
```

A **router before a launch** decides who is launched. Each route states `spawn`:
`SpawnPolicy.Always` (always launched, no prompt) or `SpawnPolicy.OnDemand` (the router decides it by
the route's `prompt`); `failure: FailurePolicy.Skip` lets a failed branch drop out instead of failing
the launch (`FailFast`, the default).

```ts file=src/support/dto/order-lookup.dto.ts
import { Text } from "@agboss/core/dto";

export class OrderLookupDto {
  @Text({ prompt: "where the order is" })
  status!: string;
}
```

```ts file=src/support/dto/refund-terms.dto.ts
import { Text } from "@agboss/core/dto";

export class RefundTermsDto {
  @Text({ prompt: "the refund terms that apply" })
  terms!: string;
}
```

```ts file=src/support/dto/loyalty-offer.dto.ts
import { Text } from "@agboss/core/dto";

export class LoyaltyOfferDto {
  @Text({ prompt: "an offer for the customer" })
  offer!: string;
}
```

```ts file=src/support/dto/support-reply.dto.ts
import { Text } from "@agboss/core/dto";

export class SupportReplyDto {
  @Text({ prompt: "the reply to send" })
  text!: string;
}
```

```ts file=src/support/workflows/support-launch/support-launch.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "support-launch-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class SupportLaunchWorkflowStart {}
```

```ts file=src/support/agents/order-lookup/order-lookup.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { OrderLookupDto } from "../../dto/order-lookup.dto.js";

@Agent({
  name: "order-lookup-agent",
  description: "Looks the order up",
  prompt: "Say where the order is.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: OrderLookupDto,
})
export class OrderLookupAgent {}
```

```ts file=src/support/agents/refund-terms/refund-terms.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { RefundTermsDto } from "../../dto/refund-terms.dto.js";

@Agent({
  name: "refund-terms-agent",
  description: "Quotes the refund terms",
  prompt: "Quote the refund terms that apply.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: RefundTermsDto,
})
export class RefundTermsAgent {}
```

```ts file=src/support/agents/loyalty-offer/loyalty-offer.agent.ts
import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferDto } from "../../dto/loyalty-offer.dto.js";

@Agent({
  name: "loyalty-offer-agent",
  description: "Finds an offer for the customer",
  prompt: "Find one offer for the customer.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: LoyaltyOfferDto,
})
export class LoyaltyOfferAgent {}
```

```ts file=src/support/agents/support-reply/support-reply.agent.ts
import { Agent, optional } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferDto } from "../../dto/loyalty-offer.dto.js";
import { OrderLookupDto } from "../../dto/order-lookup.dto.js";
import { RefundTermsDto } from "../../dto/refund-terms.dto.js";
import { SupportReplyDto } from "../../dto/support-reply.dto.js";

@Agent({
  name: "support-reply-agent",
  description: "Writes the reply from what was found",
  prompt: "Reply to the customer from the findings.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    order: OrderLookupDto,
    refund: optional(RefundTermsDto),
    loyalty: optional(LoyaltyOfferDto),
  },
  output: SupportReplyDto,
})
export class SupportReplyAgent {}
```

```ts file=src/support/workflows/support-launch/support-reply.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { SupportReplyDto } from "../../dto/support-reply.dto.js";

@WorkflowFinish({ name: "support-reply-workflow-finish", description: "The reply", output: SupportReplyDto })
export class SupportReplyWorkflowFinish {}
```

```ts file=src/support/routers/support-launch/support-launch.router.ts
import { DecidedBy, FailurePolicy, Router, SpawnPolicy } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferAgent } from "../../agents/loyalty-offer/loyalty-offer.agent.js";
import { OrderLookupAgent } from "../../agents/order-lookup/order-lookup.agent.js";
import { RefundTermsAgent } from "../../agents/refund-terms/refund-terms.agent.js";

@Router({
  name: "support-launch-router",
  description: "Picks everyone the customer's message needs",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick everyone needed to answer the customer's message.",
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: OrderLookupAgent, spawn: SpawnPolicy.Always }, // always launched: no prompt
    { target: RefundTermsAgent, spawn: SpawnPolicy.OnDemand, prompt: "The message is about a return" },
    { target: LoyaltyOfferAgent, spawn: SpawnPolicy.Always, failure: FailurePolicy.Skip },
  ],
})
export class SupportLaunchRouter {}
```

```ts file=src/support/workflows/support-launch/support-launch.workflow.ts
import { Workflow, optional, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferAgent } from "../../agents/loyalty-offer/loyalty-offer.agent.js";
import { OrderLookupAgent } from "../../agents/order-lookup/order-lookup.agent.js";
import { RefundTermsAgent } from "../../agents/refund-terms/refund-terms.agent.js";
import { SupportReplyAgent } from "../../agents/support-reply/support-reply.agent.js";
import { LoyaltyOfferDto } from "../../dto/loyalty-offer.dto.js";
import { OrderLookupDto } from "../../dto/order-lookup.dto.js";
import { RefundTermsDto } from "../../dto/refund-terms.dto.js";
import { SupportReplyDto } from "../../dto/support-reply.dto.js";
import { SupportLaunchRouter } from "../../routers/support-launch/support-launch.router.js";
import { SupportLaunchWorkflowStart } from "./support-launch.workflow-start.js";
import { SupportReplyWorkflowFinish } from "./support-reply.workflow-finish.js";

@Workflow({
  name: "support-launch-workflow",
  version: "1.0.0",
  flow: [
    start(SupportLaunchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(SupportLaunchRouter)
      .toParallelAgents(OrderLookupAgent, RefundTermsAgent, LoyaltyOfferAgent) // exactly its routes
      .join()
      .returns(OrderLookupDto)
      .returns(optional(RefundTermsDto)) // OnDemand: may not be launched
      .returns(optional(LoyaltyOfferDto)) // Skip: may drop out
      .toAgent(SupportReplyAgent)
      .returns(SupportReplyDto)
      .toFinish(SupportReplyWorkflowFinish),
  ],
})
export class SupportLaunchWorkflow {}
```

Launch rules:

- A launch is always followed by `.join()` (`[launch.join-required]`, a compile error too); after the
  join `.onJoinError(E, …)` — never `.onError` — then `.returns(…)`, then exactly one `.to…(…)`: a
  second launch never follows a join directly (put a step between, as `section-notes-action` above).
- Per item: one target right after `.returns(listOf(ItemDto))`, `{ maxItems }` required
  (`[launch.max-items-required]`) and only there (`[launch.max-items-without-list]`); the target
  reads an `ItemDto` field (`[launch.item-not-read]`). The first `maxItems` items run, the rest are
  dropped without an error (`result.launches`, `onLaunchItemsTruncated`).
- A branch is one step: a launched class continued anywhere else is `[launch.branch-continued]` —
  several steps per item are a child workflow (section 6).
- A branch sees the scope at the launch, its siblings' values only after the join; a branch renewing
  what a sibling read is `[launch.branch-outdates-sibling]`.
- Before a launch a model router's every route states `spawn` (`[router.spawn-required]`), an
  `Always` route has no prompt (`[router.prompt-on-always]`), an `OnDemand` one has one
  (`[router.no-prompt]`), and at least one is `OnDemand` (`[router.all-routes-always]`). A code
  router's `route(input)` returns the `OnDemand` targets as a list.
- `maxConcurrency` is a sliding window; a failed branch aborts its siblings (`FailFast`); `Skip`
  drops only a `StepFailedError`; `app.cancel` cancels the whole execution, never a branch outcome.

## 5. Quorums, groups and arbiters

After `.toParallelAgents(…)` a join may count answers instead of waiting for all. `@Arbiter` classes
decide whether an answer counts: several `.acceptedBy(…)` are an AND in path order,
`.acceptedBy(anyOf(A, B))` stops at the first that accepts.

```ts file=src/panel/dto/panel-candidate.dto.ts
import { Text } from "@agboss/core/dto";

export class PanelCandidateDto {
  @Text({ prompt: "the candidate's CV" })
  cv!: string;
}
```

```ts file=src/panel/dto/panel-score.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class PanelScoreDto {
  @Integer({ prompt: "the score, 1 to 10" })
  score!: number;

  @Text({ prompt: "what the score rests on" })
  reason!: string;
}
```

```ts file=src/panel/dto/panel-verdict.dto.ts
import { Flag } from "@agboss/core/dto";

export class PanelVerdictDto {
  @Flag({ prompt: "whether to hire" })
  isHire!: boolean;
}
```

```ts file=src/panel/workflows/panel/panel.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";

@WorkflowStart({ name: "panel-workflow-start", description: "A candidate", input: PanelCandidateDto })
export class PanelWorkflowStart {}
```

```ts file=src/panel/agents/skills-panel/skills-panel.agent.ts
import { Agent } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "skills-panel-agent",
  description: "Scores the technical skills",
  prompt: "Score the technical skills from 1 to 10.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class SkillsPanelAgent {}
```

```ts file=src/panel/agents/culture-panel/culture-panel.agent.ts
import { Agent } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "culture-panel-agent",
  description: "Scores the team fit",
  prompt: "Score the team fit from 1 to 10.",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class CulturePanelAgent {}
```

```ts file=src/panel/agents/risk-panel/risk-panel.agent.ts
import { Agent } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "risk-panel-agent",
  description: "Scores the hiring risk",
  prompt: "Score the hiring risk from 1 (high) to 10 (low).",
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class RiskPanelAgent {}
```

```ts file=src/panel/agents/panel-verdict/panel-verdict.agent.ts
import { Agent, listOf } from "@agboss/core";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";
import { PanelVerdictDto } from "../../dto/panel-verdict.dto.js";

@Agent({
  name: "panel-verdict-agent",
  description: "Decides from the counted scores",
  prompt: "Decide whether to hire from the scores.",
  model: "moonshotai/kimi-k2.6",
  input: { scores: listOf(PanelScoreDto) },
  output: PanelVerdictDto,
})
export class PanelVerdictAgent {}
```

```ts file=src/panel/workflows/panel/panel-verdict.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PanelVerdictDto } from "../../dto/panel-verdict.dto.js";

@WorkflowFinish({ name: "panel-verdict-workflow-finish", description: "The verdict", output: PanelVerdictDto })
export class PanelVerdictWorkflowFinish {}
```

```ts file=src/panel/workflows/panel/panel-undecided.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";

@WorkflowFinish({
  name: "panel-undecided-workflow-finish",
  description: "The candidate: too few usable scores",
  output: PanelCandidateDto,
})
export class PanelUndecidedWorkflowFinish {}
```

```ts file=src/panel/arbiters/score-range/score-range.arbiter.ts
import { Arbiter, DecidedBy, OnAnswer } from "@agboss/core";
import type { ArbiterAnswerOf } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

// by code: one @OnAnswer(Agent) method per agent of the launch, named from<Agent class minus "Agent">
@Arbiter({ name: "score-range-arbiter", decidedBy: DecidedBy.Code })
export class ScoreRangeArbiter {
  @OnAnswer(SkillsPanelAgent)
  fromSkillsPanel(answer: ArbiterAnswerOf<typeof SkillsPanelAgent>): boolean {
    return this.isInRange(answer.score);
  }

  @OnAnswer(CulturePanelAgent)
  fromCulturePanel(answer: ArbiterAnswerOf<typeof CulturePanelAgent>): boolean {
    return this.isInRange(answer.score);
  }

  @OnAnswer(RiskPanelAgent)
  fromRiskPanel(answer: ArbiterAnswerOf<typeof RiskPanelAgent>): boolean {
    return this.isInRange(answer.score);
  }

  private isInRange(score: number): boolean {
    return score >= 1 && score <= 10;
  }
}
```

```ts file=src/panel/arbiters/reasoned-score/reasoned-score.arbiter.ts
import { Arbiter, DecidedBy, agent } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

// by model: one criterion per agent of the launch
@Arbiter({
  name: "reasoned-score-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: SkillsPanelAgent, prompt: "The reason names a concrete technical skill" },
    { agent: CulturePanelAgent, prompt: "The reason names a concrete trait of the team" },
    { agent: RiskPanelAgent, prompt: "The reason names a concrete risk" },
  ],
})
export class ReasonedScoreArbiter {}
```

```ts file=src/panel/arbiters/has-reason/has-reason.arbiter.ts
import { Arbiter, DecidedBy, OnAnswer } from "@agboss/core";
import type { ArbiterAnswerOf } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

@Arbiter({ name: "has-reason-arbiter", decidedBy: DecidedBy.Code })
export class HasReasonArbiter {
  @OnAnswer(SkillsPanelAgent)
  fromSkillsPanel(answer: ArbiterAnswerOf<typeof SkillsPanelAgent>): boolean {
    return answer.reason.length > 40;
  }

  @OnAnswer(CulturePanelAgent)
  fromCulturePanel(answer: ArbiterAnswerOf<typeof CulturePanelAgent>): boolean {
    return answer.reason.length > 40;
  }

  @OnAnswer(RiskPanelAgent)
  fromRiskPanel(answer: ArbiterAnswerOf<typeof RiskPanelAgent>): boolean {
    return answer.reason.length > 40;
  }
}
```

```ts file=src/panel/workflows/panel/panel.workflow.ts
import { QuorumNotReachedError, Workflow, anyOf, listOf, start, toFinish } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { PanelVerdictAgent } from "../../agents/panel-verdict/panel-verdict.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";
import { HasReasonArbiter } from "../../arbiters/has-reason/has-reason.arbiter.js";
import { ReasonedScoreArbiter } from "../../arbiters/reasoned-score/reasoned-score.arbiter.js";
import { ScoreRangeArbiter } from "../../arbiters/score-range/score-range.arbiter.js";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";
import { PanelVerdictDto } from "../../dto/panel-verdict.dto.js";
import { PanelUndecidedWorkflowFinish } from "./panel-undecided.workflow-finish.js";
import { PanelVerdictWorkflowFinish } from "./panel-verdict.workflow-finish.js";
import { PanelWorkflowStart } from "./panel.workflow-start.js";

@Workflow({
  name: "panel-workflow",
  version: "1.0.0",
  flow: [
    start(PanelWorkflowStart)
      .returns(PanelCandidateDto)
      .toParallelAgents(SkillsPanelAgent, CulturePanelAgent, RiskPanelAgent)
      .acceptedBy(ScoreRangeArbiter) // AND, in path order: the cheap check first
      .acceptedBy(anyOf(HasReasonArbiter, ReasonedScoreArbiter)) // the model only when the code rejects
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) }) // two accepted answers are enough
      .onJoinError(QuorumNotReachedError, toFinish(PanelUndecidedWorkflowFinish))
      .returns(listOf(PanelScoreDto)) // one output class from several agents: a list, in counting order
      .toAgent(PanelVerdictAgent)
      .returns(PanelVerdictDto)
      .toFinish(PanelVerdictWorkflowFinish),
  ],
})
export class PanelWorkflow {}
```

Groups — the first complete group, by priority (1 is the highest), continues **its own** path; nothing
follows the groups but `.onJoinError(…)`:

```ts file=src/deal/dto/deal.dto.ts
import { Text } from "@agboss/core/dto";

export class DealDto {
  @Text({ prompt: "the deal's terms" })
  terms!: string;
}
```

```ts file=src/deal/dto/legal-review.dto.ts
import { Flag } from "@agboss/core/dto";

export class LegalReviewDto {
  @Flag({ prompt: "whether the terms are legal" })
  isLegal!: boolean;
}
```

```ts file=src/deal/dto/deal-critique.dto.ts
import { Text } from "@agboss/core/dto";

export class DealCritiqueDto {
  @Text({ prompt: "a weakness of the deal" })
  weakness!: string;
}
```

```ts file=src/deal/dto/fast-screen.dto.ts
import { Flag } from "@agboss/core/dto";

export class FastScreenDto {
  @Flag({ prompt: "whether the deal is obviously bad" })
  isObviouslyBad!: boolean;
}
```

```ts file=src/deal/dto/deal-report.dto.ts
import { Text } from "@agboss/core/dto";

export class DealReportDto {
  @Text({ prompt: "the full review" })
  report!: string;
}
```

```ts file=src/deal/workflows/deal/deal.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";

@WorkflowStart({ name: "deal-workflow-start", description: "A deal to review", input: DealDto })
export class DealWorkflowStart {}
```

```ts file=src/deal/agents/deal-legal/deal-legal.agent.ts
import { Agent } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";
import { LegalReviewDto } from "../../dto/legal-review.dto.js";

@Agent({ name: "deal-legal-agent", description: "Checks the law", prompt: "Check the terms against the law.", model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: LegalReviewDto })
export class DealLegalAgent {}
```

```ts file=src/deal/agents/deal-critic/deal-critic.agent.ts
import { Agent } from "@agboss/core";
import { DealCritiqueDto } from "../../dto/deal-critique.dto.js";
import { DealDto } from "../../dto/deal.dto.js";

@Agent({ name: "deal-critic-agent", description: "Finds a weakness", prompt: "Name the deal's worst weakness.", model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: DealCritiqueDto })
export class DealCriticAgent {}
```

```ts file=src/deal/agents/deal-screen/deal-screen.agent.ts
import { Agent } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";
import { FastScreenDto } from "../../dto/fast-screen.dto.js";

@Agent({ name: "deal-screen-agent", description: "Screens fast", prompt: "Say whether the deal is obviously bad.", model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: FastScreenDto })
export class DealScreenAgent {}
```

```ts file=src/deal/agents/deal-report/deal-report.agent.ts
import { Agent, listOf } from "@agboss/core";
import { DealCritiqueDto } from "../../dto/deal-critique.dto.js";
import { DealReportDto } from "../../dto/deal-report.dto.js";
import { LegalReviewDto } from "../../dto/legal-review.dto.js";

@Agent({
  name: "deal-report-agent",
  description: "Writes the full review",
  prompt: "Write the review from the legal check and the critiques.",
  model: "moonshotai/kimi-k2.6",
  input: { legal: LegalReviewDto, critiques: listOf(DealCritiqueDto) },
  output: DealReportDto,
})
export class DealReportAgent {}
```

```ts file=src/deal/workflows/deal/deal-report.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { DealReportDto } from "../../dto/deal-report.dto.js";

@WorkflowFinish({ name: "deal-report-workflow-finish", description: "The review", output: DealReportDto })
export class DealReportWorkflowFinish {}
```

```ts file=src/deal/workflows/deal/deal-screened.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { FastScreenDto } from "../../dto/fast-screen.dto.js";

@WorkflowFinish({ name: "deal-screened-workflow-finish", description: "A fast verdict", output: FastScreenDto })
export class DealScreenedWorkflowFinish {}
```

```ts file=src/deal/workflows/deal/deal-unreviewed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";

@WorkflowFinish({ name: "deal-unreviewed-workflow-finish", description: "No group completed", output: DealDto })
export class DealUnreviewedWorkflowFinish {}
```

```ts file=src/deal/workflows/deal/deal.workflow.ts
import { QuorumNotReachedError, Workflow, group, listOf, start, toFinish } from "@agboss/core";
import { minutes } from "@agboss/core/units";
import { DealCriticAgent } from "../../agents/deal-critic/deal-critic.agent.js";
import { DealLegalAgent } from "../../agents/deal-legal/deal-legal.agent.js";
import { DealReportAgent } from "../../agents/deal-report/deal-report.agent.js";
import { DealScreenAgent } from "../../agents/deal-screen/deal-screen.agent.js";
import { DealCritiqueDto } from "../../dto/deal-critique.dto.js";
import { DealReportDto } from "../../dto/deal-report.dto.js";
import { DealDto } from "../../dto/deal.dto.js";
import { FastScreenDto } from "../../dto/fast-screen.dto.js";
import { LegalReviewDto } from "../../dto/legal-review.dto.js";
import { DealReportWorkflowFinish } from "./deal-report.workflow-finish.js";
import { DealScreenedWorkflowFinish } from "./deal-screened.workflow-finish.js";
import { DealUnreviewedWorkflowFinish } from "./deal-unreviewed.workflow-finish.js";
import { DealWorkflowStart } from "./deal.workflow-start.js";

@Workflow({
  name: "deal-workflow",
  version: "1.0.0",
  flow: [
    start(DealWorkflowStart)
      .returns(DealDto)
      .toParallelAgents(DealLegalAgent, DealCriticAgent, DealCriticAgent, DealScreenAgent)
      .joinQuorumGroups(
        group(DealLegalAgent, DealCriticAgent)
          .priority(1)
          .returns(LegalReviewDto)
          .returns(listOf(DealCritiqueDto)) // deal-critic-agent is launched twice: a list, even of one
          .toAgent(DealReportAgent)
          .returns(DealReportDto)
          .toFinish(DealReportWorkflowFinish),
        group(DealScreenAgent)
          .priority(2)
          .returns(FastScreenDto)
          .toFinish(DealScreenedWorkflowFinish),
        { deadline: minutes(1) },
      )
      .onJoinError(QuorumNotReachedError, toFinish(DealUnreviewedWorkflowFinish)),
  ],
})
export class DealWorkflow {}
```

Quorum rules:

- `.acceptedBy(…)` stands between the launch and the quorum (`.acceptedBy(…).join()` does not compile).
- A code arbiter has exactly one `@OnAnswer(Agent)` method per agent class of the launch —
  `[arbiter.unhandled-agent]`, `[arbiter.unknown-agent]`, `[arbiter.duplicate-agent]`, its name
  `from<Agent>` (`[arbiter.method-name]`); a model arbiter has `criteria`, never `@OnAnswer`
  (`[arbiter.answer-method-on-model]`); an undecorated class is `[arbiter.not-an-arbiter]`.
- `.joinQuorum({ min })` with `min` below the agents launched makes a single answer
  `optional(XDto)` (`[flow.quorum-return-not-optional]`); `min` above what can run, or a group that can
  never complete, is `[flow.quorum-impossible]`.
- At run time each answer is `BranchVerdict.Counted`, `Rejected` or `Surplus`; once the quorum is
  decided the rest is cancelled (`BranchStatus.Cancelled`). A quorum not reached is
  `QuorumNotReachedError` into `.onJoinError(…)`; an arbiter that throws is `ArbiterError`. The time
  a branch waits for a tree slot does not count against the `deadline`.

## 6. Child workflows

Any `@Workflow` of the application can be a step: `.toWorkflow(W)` (one child), `route(W)` (a router
picks it), `.toParallelWorkflows(W, { maxItems })` (one child per item), `workflow(W)` (its own path),
or `toWorkflow(W)` as a side-path starter. The child's scope starts with its start's input only; its
result is one of its finishes' outputs.

```ts file=src/vendor/dto/vendor.dto.ts
import { Text } from "@agboss/core/dto";

export class VendorDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;
}
```

```ts file=src/vendor/dto/vendor-score.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class VendorScoreDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;

  @Integer({ prompt: "the vendor's score, 1 to 10" })
  score!: number;
}
```

```ts file=src/vendor/dto/vendor-rejected.dto.ts
import { Text } from "@agboss/core/dto";

export class VendorRejectedDto {
  @Text({ prompt: "why the vendor was rejected" })
  reason!: string;
}
```

```ts file=src/vendor/dto/vendor-check-failed.dto.ts
import { Text } from "@agboss/core/dto";

export class VendorCheckFailedDto {
  @Text({ prompt: "the vendor whose check failed" })
  name!: string;
}
```

```ts file=src/vendor/dto/vendor-ranking.dto.ts
import { Text } from "@agboss/core/dto";

export class VendorRankingDto {
  @Text({ prompt: "the vendors, best first" })
  ranking!: string;
}
```

```ts file=src/vendor/workflows/vendor-check/vendor-check.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { VendorDto } from "../../dto/vendor.dto.js";

@WorkflowStart({ name: "vendor-check-workflow-start", description: "One vendor to check", input: VendorDto })
export class VendorCheckWorkflowStart {}
```

```ts file=src/vendor/agents/vendor-checker/vendor-checker.agent.ts
import { Agent, oneOf } from "@agboss/core";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorDto } from "../../dto/vendor.dto.js";

@Agent({
  name: "vendor-checker-agent",
  description: "Scores a vendor, or rejects it",
  prompt: "Score the vendor from 1 to 10, or reject it with a reason.",
  model: "moonshotai/kimi-k2.6",
  input: { vendor: VendorDto },
  output: oneOf(VendorScoreDto, VendorRejectedDto),
})
export class VendorCheckerAgent {}
```

```ts file=src/vendor/actions/mark-vendor-failed.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { VendorCheckFailedDto } from "../dto/vendor-check-failed.dto.js";
import { VendorDto } from "../dto/vendor.dto.js";

@Action({
  name: "mark-vendor-failed-action",
  description: "Records that the vendor could not be checked",
  input: { vendor: VendorDto },
  output: VendorCheckFailedDto,
})
export class MarkVendorFailedAction implements ActionHandler<MarkVendorFailedAction> {
  execute(input: InputOf<MarkVendorFailedAction>): Promise<OutputOf<MarkVendorFailedAction>> {
    return Promise.resolve({ name: input.vendor.value.name });
  }
}
```

```ts file=src/vendor/workflows/vendor-check/vendor-scored.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

@WorkflowFinish({ name: "vendor-scored-workflow-finish", description: "The score", output: VendorScoreDto })
export class VendorScoredWorkflowFinish {}
```

```ts file=src/vendor/workflows/vendor-check/vendor-rejected.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";

@WorkflowFinish({ name: "vendor-rejected-workflow-finish", description: "The rejection", output: VendorRejectedDto })
export class VendorRejectedWorkflowFinish {}
```

```ts file=src/vendor/workflows/vendor-check/vendor-check-failed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";

@WorkflowFinish({ name: "vendor-check-failed-workflow-finish", description: "The check failed", output: VendorCheckFailedDto })
export class VendorCheckFailedWorkflowFinish {}
```

```ts file=src/vendor/workflows/vendor-check/vendor-check.workflow.ts
// the child: an ordinary @Workflow — one vendor, its own branches, a soft failure on its side path
import { StepFailedError, Workflow, caseOf, oneOf, start, toAction } from "@agboss/core";
import { MarkVendorFailedAction } from "../../actions/mark-vendor-failed.action.js";
import { VendorCheckerAgent } from "../../agents/vendor-checker/vendor-checker.agent.js";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorDto } from "../../dto/vendor.dto.js";
import { VendorCheckFailedWorkflowFinish } from "./vendor-check-failed.workflow-finish.js";
import { VendorCheckWorkflowStart } from "./vendor-check.workflow-start.js";
import { VendorRejectedWorkflowFinish } from "./vendor-rejected.workflow-finish.js";
import { VendorScoredWorkflowFinish } from "./vendor-scored.workflow-finish.js";

@Workflow({
  name: "vendor-check-workflow",
  version: "1.0.0",
  flow: [
    start(VendorCheckWorkflowStart)
      .returns(VendorDto)
      .toAgent(VendorCheckerAgent)
      .onError(
        StepFailedError, // the child catches its own failure: one more result class for its parent
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
})
export class VendorCheckWorkflow {}
```

```ts file=src/vendor/workflows/vendor-screening/vendor-screening.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "vendor-screening-workflow-start", description: "What to buy", input: WorkflowStartTextDto })
export class VendorScreeningWorkflowStart {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { VendorDto } from "../../dto/vendor.dto.js";

@WorkflowStart({ name: "single-vendor-workflow-start", description: "One vendor by name", input: VendorDto })
export class SingleVendorWorkflowStart {}
```

```ts file=src/vendor/agents/vendor-finder/vendor-finder.agent.ts
import { Agent, listOf } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { VendorDto } from "../../dto/vendor.dto.js";

@Agent({
  name: "vendor-finder-agent",
  description: "Finds vendors for the request",
  prompt: "List the vendors that can deliver the request.",
  model: "moonshotai/kimi-k2.6",
  input: { request: WorkflowStartTextDto },
  output: listOf(VendorDto),
})
export class VendorFinderAgent {}
```

```ts file=src/vendor/agents/vendor-ranker/vendor-ranker.agent.ts
import { Agent, listOf, oneOf } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRankingDto } from "../../dto/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

@Agent({
  name: "vendor-ranker-agent",
  description: "Ranks the checked vendors",
  prompt: "Rank the scored vendors; mention the rejected and failed ones.",
  model: "moonshotai/kimi-k2.6",
  input: { checks: listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)) },
  output: VendorRankingDto,
})
export class VendorRankerAgent {}
```

```ts file=src/vendor/workflows/vendor-screening/vendor-ranking.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorRankingDto } from "../../dto/vendor-ranking.dto.js";

@WorkflowFinish({ name: "vendor-ranking-workflow-finish", description: "The ranking", output: VendorRankingDto })
export class VendorRankingWorkflowFinish {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor-scored.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

@WorkflowFinish({ name: "single-vendor-scored-workflow-finish", description: "The vendor's score", output: VendorScoreDto })
export class SingleVendorScoredWorkflowFinish {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor-rejected.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";

@WorkflowFinish({ name: "single-vendor-rejected-workflow-finish", description: "Not this vendor", output: VendorRejectedDto })
export class SingleVendorRejectedWorkflowFinish {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor-failed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";

@WorkflowFinish({ name: "single-vendor-failed-workflow-finish", description: "Not checked", output: VendorCheckFailedDto })
export class SingleVendorFailedWorkflowFinish {}
```

```ts file=src/vendor/workflows/single-vendor/vendor-crashed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { VendorDto } from "../../dto/vendor.dto.js";

@WorkflowFinish({ name: "vendor-crashed-workflow-finish", description: "The child failed", output: VendorDto })
export class VendorCrashedWorkflowFinish {}
```

```ts file=src/vendor/workflows/vendor-screening/vendor-screening.workflow.ts
import { Workflow, listOf, oneOf, start } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { VendorFinderAgent } from "../../agents/vendor-finder/vendor-finder.agent.js";
import { VendorRankerAgent } from "../../agents/vendor-ranker/vendor-ranker.agent.js";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRankingDto } from "../../dto/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorDto } from "../../dto/vendor.dto.js";
import { VendorCheckWorkflow } from "../vendor-check/vendor-check.workflow.js";
import { VendorRankingWorkflowFinish } from "./vendor-ranking.workflow-finish.js";
import { VendorScreeningWorkflowStart } from "./vendor-screening.workflow-start.js";

@Workflow({
  name: "vendor-screening-workflow",
  version: "1.0.0",
  flow: [
    // one child per item: each VendorDto enters vendor-check-workflow-start; the join is the list
    // of the child's finish output classes
    start(VendorScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(VendorFinderAgent)
      .returns(listOf(VendorDto))
      .toParallelWorkflows(VendorCheckWorkflow, { maxConcurrency: 3, maxItems: 20 })
      .join()
      .returns(listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto))) // one polymorphic list
      .toAgent(VendorRankerAgent)
      .returns(VendorRankingDto)
      .toFinish(VendorRankingWorkflowFinish),
  ],
})
export class VendorScreeningWorkflow {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor.workflow.ts
import { ChildExecutionFailedError, Workflow, caseOf, oneOf, start, toFinish } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorDto } from "../../dto/vendor.dto.js";
import { VendorCheckWorkflow } from "../vendor-check/vendor-check.workflow.js";
import { SingleVendorFailedWorkflowFinish } from "./single-vendor-failed.workflow-finish.js";
import { SingleVendorRejectedWorkflowFinish } from "./single-vendor-rejected.workflow-finish.js";
import { SingleVendorScoredWorkflowFinish } from "./single-vendor-scored.workflow-finish.js";
import { SingleVendorWorkflowStart } from "./single-vendor.workflow-start.js";
import { VendorCrashedWorkflowFinish } from "./vendor-crashed.workflow-finish.js";

// another parent, one child: its result is one of its finishes' classes — one case per class.
// (In one workflow a child class is one node: a per-item launch and a single launch of it are
// [launch.branch-continued] — a launched branch is continued only by its join.)
@Workflow({
  name: "single-vendor-workflow",
  version: "1.0.0",
  flow: [
    start(SingleVendorWorkflowStart)
      .returns(VendorDto)
      .toWorkflow(VendorCheckWorkflow)
      .onError(
        ChildExecutionFailedError, // an uncaught error of the child (its step, maxSteps, maxVisits)
        toFinish(VendorCrashedWorkflowFinish),
      )
      .returns(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto))
      .switch(
        caseOf(VendorScoreDto)
          .toFinish(SingleVendorScoredWorkflowFinish),
        caseOf(VendorRejectedDto)
          .toFinish(SingleVendorRejectedWorkflowFinish),
        caseOf(VendorCheckFailedDto)
          .toFinish(SingleVendorFailedWorkflowFinish),
      ),
  ],
})
export class SingleVendorWorkflow {}
```

A child as an error handler — `toWorkflow(W)` starts a side path:

```ts file=src/payment/dto/payment-request.dto.ts
import { Text } from "@agboss/core/dto";

export class PaymentRequestDto {
  @Text({ prompt: "the payment's id" })
  paymentId!: string;
}
```

```ts file=src/payment/dto/payment-done.dto.ts
import { Text } from "@agboss/core/dto";

export class PaymentDoneDto {
  @Text({ prompt: "the receipt" })
  receipt!: string;
}
```

```ts file=src/payment/workflows/pay/pay.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { PaymentRequestDto } from "../../dto/payment-request.dto.js";

@WorkflowStart({ name: "pay-workflow-start", description: "A payment", input: PaymentRequestDto })
export class PayWorkflowStart {}
```

```ts file=src/payment/workflows/payment-recovery/payment-recovery.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { PaymentRequestDto } from "../../dto/payment-request.dto.js";

@WorkflowStart({ name: "payment-recovery-workflow-start", description: "A failed payment", input: PaymentRequestDto })
export class PaymentRecoveryWorkflowStart {}
```

```ts file=src/payment/actions/charge-card.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { PaymentDoneDto } from "../dto/payment-done.dto.js";
import { PaymentRequestDto } from "../dto/payment-request.dto.js";

@Action({ name: "charge-card-action", description: "Charges the card", input: { payment: PaymentRequestDto }, output: PaymentDoneDto })
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ receipt: `card:${input.payment.value.paymentId}` });
  }
}
```

```ts file=src/payment/actions/send-invoice.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { PaymentDoneDto } from "../dto/payment-done.dto.js";
import { PaymentRequestDto } from "../dto/payment-request.dto.js";

@Action({ name: "send-invoice-action", description: "Sends an invoice instead", input: { payment: PaymentRequestDto }, output: PaymentDoneDto })
export class SendInvoiceAction implements ActionHandler<SendInvoiceAction> {
  execute(input: InputOf<SendInvoiceAction>): Promise<OutputOf<SendInvoiceAction>> {
    return Promise.resolve({ receipt: `invoice:${input.payment.value.paymentId}` });
  }
}
```

```ts file=src/payment/workflows/payment-recovery/invoiced.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";

@WorkflowFinish({ name: "invoiced-workflow-finish", description: "Invoiced", output: PaymentDoneDto })
export class InvoicedWorkflowFinish {}
```

```ts file=src/payment/workflows/pay/paid.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";

@WorkflowFinish({ name: "paid-workflow-finish", description: "Paid by card", output: PaymentDoneDto })
export class PaidWorkflowFinish {}
```

```ts file=src/payment/workflows/pay/recovered.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";

@WorkflowFinish({ name: "recovered-workflow-finish", description: "Paid another way", output: PaymentDoneDto })
export class RecoveredWorkflowFinish {}
```

```ts file=src/payment/workflows/payment-recovery/payment-recovery.workflow.ts
import { Workflow, start } from "@agboss/core";
import { SendInvoiceAction } from "../../actions/send-invoice.action.js";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";
import { PaymentRequestDto } from "../../dto/payment-request.dto.js";
import { InvoicedWorkflowFinish } from "./invoiced.workflow-finish.js";
import { PaymentRecoveryWorkflowStart } from "./payment-recovery.workflow-start.js";

@Workflow({
  name: "payment-recovery-workflow",
  version: "1.0.0",
  flow: [
    start(PaymentRecoveryWorkflowStart)
      .returns(PaymentRequestDto)
      .toAction(SendInvoiceAction)
      .returns(PaymentDoneDto)
      .toFinish(InvoicedWorkflowFinish),
  ],
})
export class PaymentRecoveryWorkflow {}
```

```ts file=src/payment/workflows/pay/pay.workflow.ts
import { StepFailedError, Workflow, start, toWorkflow } from "@agboss/core";
import { ChargeCardAction } from "../../actions/charge-card.action.js";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";
import { PaymentRequestDto } from "../../dto/payment-request.dto.js";
import { PaymentRecoveryWorkflow } from "../payment-recovery/payment-recovery.workflow.js";
import { PaidWorkflowFinish } from "./paid.workflow-finish.js";
import { PayWorkflowStart } from "./pay.workflow-start.js";
import { RecoveredWorkflowFinish } from "./recovered.workflow-finish.js";

@Workflow({
  name: "pay-workflow",
  version: "1.0.0",
  flow: [
    start(PayWorkflowStart)
      .returns(PaymentRequestDto)
      .toAction(ChargeCardAction)
      .onError(
        StepFailedError, // the charge failed: the recovery workflow takes it from here
        toWorkflow(PaymentRecoveryWorkflow)
          .returns(PaymentDoneDto)
          .toFinish(RecoveredWorkflowFinish),
      )
      .returns(PaymentDoneDto)
      .toFinish(PaidWorkflowFinish),
  ],
})
export class PayWorkflow {}
```

Child rules:

- **Which start**: chosen per edge, by class — a child with one start is entered through it; else the
  start with a required field of the item's type (per item) or of the chain's current value. None →
  `[graph.no-matching-start]`; two → `[graph.ambiguous-start]` (fix: make one start's input a
  subclass, `class QuickVendorDto extends VendorDto {}`). Both are compile errors too.
- **Errors**: `.onError(E, …)` right after `.toWorkflow(W)` or `workflow(W)`; `.onJoinError(E, …)`
  right after a per-item join. An uncaught error of the child — its step, its `maxSteps`, a node's
  `maxVisits` — is the parent's `ChildExecutionFailedError` (a `StepFailedError`: `cause`,
  `childExecutionId`, `itemIndex`, `workflow`), so its handler may be an agent. An exhausted budget,
  a cancel and `CompensationFailedError` stop the whole tree as they are — never wrapped.
- **Soft failure per item**: a child that catches its own error and ends at a failure finish gives
  one more result class; a per-item child with no finish reachable from an `.onError` side path warns
  `[graph.child-without-failure-finish]` (one failed item would cancel all the others).
- A child need not be listed in `@Application({ workflows })`; it runs alone through its own starts too.
  It spends from the root's budgets; its own execution budget applies only when it runs as the root.
- **Where it runs (#333)**: on its parent's instance by default; `{ placement:
ChildPlacement.AnyInstance }` on `.toWorkflow(W, …)`, `.toParallelWorkflows(W, { …, placement })`
  or `route(W, …)` queues it for any instance with a free step slot (list
  `SqliteChildExecutionQueueRepository`, else `[application.in-memory-child-queue]`). One class has
  one placement (`[flow.conflicting-placement]`); pauses, `app.resume`, and per-child crash recovery
  work across instances on `<parentThreadId>/child/<id>`.

## 7. Recursion: `ThisWorkflow`

A workflow launches itself with the marker `ThisWorkflow` (its class does not exist yet when its
decorator's arguments are evaluated). `@Workflow({ maxDepth })` is required; on the last level
(`depth === maxDepth`) the options of a branch that would recurse are not offered — so every such
branch keeps one that does not recurse.

```ts file=src/topic/dto/topic.dto.ts
import { Integer, Text } from "@agboss/core/dto";

export class TopicDto {
  @Text({ prompt: "the topic to research" })
  topic!: string;

  @Integer({ prompt: "how deep this topic is in the tree, from 1", min: 1 })
  level!: number; // a domain level the model may read — never executionContext.depth
}
```

```ts file=src/topic/dto/topic-report.dto.ts
import { Text } from "@agboss/core/dto";

export class TopicReportDto {
  @Text({ prompt: "what is known about the topic" })
  report!: string;
}
```

```ts file=src/topic/dto/topic-too-broad.dto.ts
import { Text } from "@agboss/core/dto";

export class TopicTooBroadDto {
  @Text({ prompt: "why the topic needs splitting" })
  reason!: string;
}
```

```ts file=src/topic/dto/topic-failed.dto.ts
import { Text } from "@agboss/core/dto";

export class TopicFailedDto {
  @Text({ prompt: "the topic that could not be researched" })
  topic!: string;
}
```

```ts file=src/topic/workflows/topic-research/topic-research.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { TopicDto } from "../../dto/topic.dto.js";

@WorkflowStart({ name: "topic-research-workflow-start", description: "A topic", input: TopicDto })
export class TopicResearchWorkflowStart {}
```

```ts file=src/topic/agents/topic-researcher/topic-researcher.agent.ts
import { Agent, oneOf } from "@agboss/core";
import { TopicReportDto } from "../../dto/topic-report.dto.js";
import { TopicTooBroadDto } from "../../dto/topic-too-broad.dto.js";
import { TopicDto } from "../../dto/topic.dto.js";

@Agent({
  name: "topic-researcher-agent",
  description: "Reports on a topic, or says it is too broad",
  prompt: "Report on the topic, or say it is too broad to cover at once.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto },
  output: oneOf(TopicReportDto, TopicTooBroadDto), // on the last level TopicTooBroadDto leaves the schema
})
export class TopicResearcherAgent {}
```

```ts file=src/topic/actions/split-topic.action.ts
import { Action, listOf } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { TopicDto } from "../dto/topic.dto.js";

@Action({ name: "split-topic-action", description: "Splits a broad topic in three", input: { topic: TopicDto }, output: listOf(TopicDto) })
export class SplitTopicAction implements ActionHandler<SplitTopicAction> {
  execute(input: InputOf<SplitTopicAction>): Promise<OutputOf<SplitTopicAction>> {
    const { topic, level } = input.topic.value;
    return Promise.resolve(["history", "state", "outlook"].map((part) => ({ topic: `${topic}: ${part}`, level: level + 1 })));
  }
}
```

```ts file=src/topic/agents/topic-merge/topic-merge.agent.ts
import { Agent, listOf, oneOf } from "@agboss/core";
import { TopicFailedDto } from "../../dto/topic-failed.dto.js";
import { TopicReportDto } from "../../dto/topic-report.dto.js";
import { TopicDto } from "../../dto/topic.dto.js";

@Agent({
  name: "topic-merge-agent",
  description: "Merges the subtopics' reports",
  prompt: "Merge the reports into one; note the subtopics that failed.",
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto, parts: listOf(oneOf(TopicReportDto, TopicFailedDto)) },
  output: TopicReportDto,
})
export class TopicMergeAgent {}
```

```ts file=src/topic/actions/mark-topic-failed.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { TopicFailedDto } from "../dto/topic-failed.dto.js";
import { TopicDto } from "../dto/topic.dto.js";

@Action({ name: "mark-topic-failed-action", description: "Records a failed topic", input: { topic: TopicDto }, output: TopicFailedDto })
export class MarkTopicFailedAction implements ActionHandler<MarkTopicFailedAction> {
  execute(input: InputOf<MarkTopicFailedAction>): Promise<OutputOf<MarkTopicFailedAction>> {
    return Promise.resolve({ topic: input.topic.value.topic });
  }
}
```

```ts file=src/topic/workflows/topic-research/topic-report.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { TopicReportDto } from "../../dto/topic-report.dto.js";

@WorkflowFinish({ name: "topic-report-workflow-finish", description: "The report", output: TopicReportDto })
export class TopicReportWorkflowFinish {}
```

```ts file=src/topic/workflows/topic-research/topic-failed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { TopicFailedDto } from "../../dto/topic-failed.dto.js";

@WorkflowFinish({ name: "topic-failed-workflow-finish", description: "The failed topic", output: TopicFailedDto })
export class TopicFailedWorkflowFinish {}
```

```ts file=src/topic/workflows/topic-research/topic-research.workflow.ts
import { StepFailedError, ThisWorkflow, Workflow, action, caseOf, listOf, oneOf, start, toAction } from "@agboss/core";
import { MarkTopicFailedAction } from "../../actions/mark-topic-failed.action.js";
import { SplitTopicAction } from "../../actions/split-topic.action.js";
import { TopicMergeAgent } from "../../agents/topic-merge/topic-merge.agent.js";
import { TopicResearcherAgent } from "../../agents/topic-researcher/topic-researcher.agent.js";
import { TopicFailedDto } from "../../dto/topic-failed.dto.js";
import { TopicReportDto } from "../../dto/topic-report.dto.js";
import { TopicTooBroadDto } from "../../dto/topic-too-broad.dto.js";
import { TopicDto } from "../../dto/topic.dto.js";
import { TopicFailedWorkflowFinish } from "./topic-failed.workflow-finish.js";
import { TopicReportWorkflowFinish } from "./topic-report.workflow-finish.js";
import { TopicResearchWorkflowStart } from "./topic-research.workflow-start.js";

@Workflow({
  name: "topic-research-workflow",
  version: "1.0.0",
  flow: [
    start(TopicResearchWorkflowStart)
      .returns(TopicDto)
      .toAgent(TopicResearcherAgent)
      .onError(StepFailedError, toAction(MarkTopicFailedAction)) // a failed topic ends softly
      .returns(oneOf(TopicReportDto, TopicTooBroadDto))
      .switch(
        caseOf(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
        caseOf(TopicTooBroadDto) // not offered on the last level: this case recurses
          .toAction(SplitTopicAction)
          .returns(listOf(TopicDto))
          .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 3 })
          .join()
          .returns(listOf(oneOf(TopicReportDto, TopicFailedDto)))
          .toAgent(TopicMergeAgent)
          .onError(StepFailedError, toAction(MarkTopicFailedAction))
          .returns(TopicReportDto)
          .toFinish(TopicReportWorkflowFinish),
      ),

    // two ways in (the researcher's error, the merge's error): its own path
    action(MarkTopicFailedAction)
      .returns(TopicFailedDto)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  maxDepth: 3, // executions at depth 1 (the root) to 3
  maxConcurrentExecutions: 4, // executions of the whole tree at work at once
})
export class TopicResearchWorkflow {}
```

- No `maxDepth` → `[graph.recursion-without-depth]`; a branch whose every option recurses →
  `[graph.recursion-without-exit]`; only direct recursion — two workflows launching each other, or a
  flow naming its own class instead of `ThisWorkflow`, is `[graph.mutual-recursion]`.
- A launch by code or data past `maxDepth` does not start: the parent's step fails with
  `ChildExecutionFailedError` caused by `DepthLimitExceededError` — take it with
  `.onError(LimitExceededError, …)` (actions and finishes only) right after the launch, or
  `.onJoinError(…)` after a per-item join.
- `@Workflow({ maxConcurrentExecutions })` (default 10, a whole number from 1,
  `[limits.max-concurrent-executions-invalid]`) is how many executions of the tree work at once; a
  child's own larger cap is never reached (`[limits.child-concurrency-above-parent]`, a warning).
- Each level has its own `maxSteps`; the root's budgets pay for the whole tree.

## 8. Undo: compensation on side paths, and the automatic undo

An action that changes the world declares its undo: `@Action({ compensateWith: UndoAction })`, and
optionally its commit point, `committedBy: CommitAction` — once that succeeds nothing undoes it. The
undo is an ordinary `@Action` (code, never a model call) that reads only what the path holds **right
after** its action.

- **Explicit where a path can say it.** A side path (`.onError` / `.onJoinError`) entered after an
  undoable action succeeded must reach its finish through the undo, newest first — `npx agboss check`
  proves it (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`). The record of the
  undo is `CompensationReason.SidePath`.
- **Automatic where no path can say it.** A failed join undoes its finished undoable branches before
  `.onJoinError` runs (`JoinFailed`); an execution that ends without a finish — an uncaught failure
  or limit (`ExecutionFailed`), a cancel or a `FailFast` abort (`ExecutionCancelled`) — undoes its
  open actions, newest first, before it ends. Each automatic undo runs in its own frame (its key is
  the undone step's key + `:compensation`), on a clean-up signal bounded by
  `@Application({ compensationTimeout })` (default `seconds(15)`), with no budget check; it survives
  a crash (the next holder of the tree finishes it).
- An undo that fails does not stop the others; then the execution fails with
  `CompensationFailedError` (`failures`, `cause` the original error) — no side path takes it.

```ts file=src/order/dto/order-request.dto.ts
import { Text } from "@agboss/core/dto";

export class OrderRequestDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;
}
```

```ts file=src/order/dto/stock-reservation.dto.ts
import { Text } from "@agboss/core/dto";

export class StockReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}
```

```ts file=src/order/dto/card-payment.dto.ts
import { Text } from "@agboss/core/dto";

export class CardPaymentDto {
  @Text({ prompt: "the payment's id" })
  paymentId!: string;
}
```

```ts file=src/order/dto/order-shipped.dto.ts
import { Text } from "@agboss/core/dto";

export class OrderShippedDto {
  @Text({ prompt: "the tracking number" })
  trackingNumber!: string;
}
```

```ts file=src/order/errors/carrier.error.ts


export class CarrierError extends Error {}
```

```ts file=src/order/errors/payment-provider.error.ts


export class PaymentProviderError extends Error {}
```

```ts file=src/order/workflows/order/order.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { OrderRequestDto } from "../../dto/order-request.dto.js";

@WorkflowStart({ name: "order-workflow-start", description: "An order to ship", input: OrderRequestDto })
export class OrderWorkflowStart {}
```

```ts file=src/order/actions/release-stock.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { StockReservationDto } from "../dto/stock-reservation.dto.js";

// the undo actions: ordinary actions, safe to run twice (they get an idempotency key like any step)
@Action({ name: "release-stock-action", description: "Releases the reserved stock", input: { reservation: StockReservationDto }, deps: [ExecutionContext] })
export class ReleaseStockAction implements ActionHandler<ReleaseStockAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: InputOf<ReleaseStockAction>): Promise<void> {
    await Promise.resolve(`${input.reservation.value.reservationId}:${this.executionContext.step.idempotencyKey}`);
  }
}
```

```ts file=src/order/actions/refund-card.action.ts
import { Action, ExecutionContext } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { CardPaymentDto } from "../dto/card-payment.dto.js";

@Action({ name: "refund-card-action", description: "Refunds the card", input: { payment: CardPaymentDto }, deps: [ExecutionContext] })
export class RefundCardAction implements ActionHandler<RefundCardAction> {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: InputOf<RefundCardAction>): Promise<void> {
    await Promise.resolve(`${input.payment.value.paymentId}:${this.executionContext.step.idempotencyKey}`);
  }
}
```

```ts file=src/order/actions/confirm-order.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { OrderShippedDto } from "../dto/order-shipped.dto.js";

@Action({ name: "confirm-order-action", description: "Confirms the order: nothing is undone after it", input: { shipped: OrderShippedDto } })
export class ConfirmOrderAction implements ActionHandler<ConfirmOrderAction> {
  async execute(input: InputOf<ConfirmOrderAction>): Promise<void> {
    await Promise.resolve(input.shipped.value.trackingNumber);
  }
}
```

```ts file=src/order/actions/reserve-stock.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { OrderRequestDto } from "../dto/order-request.dto.js";
import { StockReservationDto } from "../dto/stock-reservation.dto.js";
import { ReleaseStockAction } from "./release-stock.action.js";

// the undoable actions: each names its undo; the payment also its commit point
@Action({
  name: "reserve-stock-action",
  description: "Reserves the stock",
  input: { order: OrderRequestDto },
  output: StockReservationDto,
  compensateWith: ReleaseStockAction, // reads the StockReservationDto this action returns
})
export class ReserveStockAction implements ActionHandler<ReserveStockAction> {
  execute(input: InputOf<ReserveStockAction>): Promise<OutputOf<ReserveStockAction>> {
    return Promise.resolve({ reservationId: `reservation-${input.order.value.orderId}` });
  }
}
```

```ts file=src/order/actions/charge-order-card.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { CardPaymentDto } from "../dto/card-payment.dto.js";
import { OrderRequestDto } from "../dto/order-request.dto.js";
import { ConfirmOrderAction } from "./confirm-order.action.js";
import { RefundCardAction } from "./refund-card.action.js";

@Action({
  name: "charge-order-card-action",
  description: "Charges the card",
  input: { order: OrderRequestDto },
  output: CardPaymentDto,
  compensateWith: RefundCardAction,
  committedBy: ConfirmOrderAction, // every path after it runs the confirm or the refund
})
export class ChargeOrderCardAction implements ActionHandler<ChargeOrderCardAction> {
  execute(input: InputOf<ChargeOrderCardAction>): Promise<OutputOf<ChargeOrderCardAction>> {
    return Promise.resolve({ paymentId: `payment-${input.order.value.orderId}` });
  }
}
```

```ts file=src/order/actions/ship-order.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { OrderRequestDto } from "../dto/order-request.dto.js";
import { OrderShippedDto } from "../dto/order-shipped.dto.js";

@Action({ name: "ship-order-action", description: "Hands the order to the carrier", input: { order: OrderRequestDto }, output: OrderShippedDto })
export class ShipOrderAction implements ActionHandler<ShipOrderAction> {
  execute(input: InputOf<ShipOrderAction>): Promise<OutputOf<ShipOrderAction>> {
    return Promise.resolve({ trackingNumber: `track-${input.order.value.orderId}` });
  }
}
```

```ts file=src/order/actions/notify-finance.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { OrderRequestDto } from "../dto/order-request.dto.js";

@Action({ name: "notify-finance-action", description: "Tells finance a refund failed", input: { order: OrderRequestDto } })
export class NotifyFinanceAction implements ActionHandler<NotifyFinanceAction> {
  async execute(input: InputOf<NotifyFinanceAction>): Promise<void> {
    await Promise.resolve(input.order.value.orderId);
  }
}
```

```ts file=src/order/workflows/order/order-failed.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OrderRequestDto } from "../../dto/order-request.dto.js";

@WorkflowFinish({ name: "order-failed-workflow-finish", description: "The order could not be shipped", output: OrderRequestDto })
export class OrderFailedWorkflowFinish {}
```

```ts file=src/order/workflows/order/order-shipped.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { OrderShippedDto } from "../../dto/order-shipped.dto.js";

@WorkflowFinish({ name: "order-shipped-workflow-finish", description: "The shipped order", output: OrderShippedDto })
export class OrderShippedWorkflowFinish {}
```

```ts file=src/order/workflows/order/order.workflow.ts
import { Workflow, action, start, toAction } from "@agboss/core";
import { ChargeOrderCardAction } from "../../actions/charge-order-card.action.js";
import { ConfirmOrderAction } from "../../actions/confirm-order.action.js";
import { NotifyFinanceAction } from "../../actions/notify-finance.action.js";
import { RefundCardAction } from "../../actions/refund-card.action.js";
import { ReleaseStockAction } from "../../actions/release-stock.action.js";
import { ReserveStockAction } from "../../actions/reserve-stock.action.js";
import { ShipOrderAction } from "../../actions/ship-order.action.js";
import { CardPaymentDto } from "../../dto/card-payment.dto.js";
import { OrderRequestDto } from "../../dto/order-request.dto.js";
import { OrderShippedDto } from "../../dto/order-shipped.dto.js";
import { StockReservationDto } from "../../dto/stock-reservation.dto.js";
import { CarrierError } from "../../errors/carrier.error.js";
import { PaymentProviderError } from "../../errors/payment-provider.error.js";
import { OrderFailedWorkflowFinish } from "./order-failed.workflow-finish.js";
import { OrderShippedWorkflowFinish } from "./order-shipped.workflow-finish.js";
import { OrderWorkflowStart } from "./order.workflow-start.js";

@Workflow({
  name: "order-workflow",
  version: "1.0.0",
  flow: [
    start(OrderWorkflowStart)
      .returns(OrderRequestDto)
      .toAction(ReserveStockAction)
      .returns(StockReservationDto)
      .toAction(ChargeOrderCardAction)
      .returns(CardPaymentDto)
      .toAction(ShipOrderAction)
      .onError(
        CarrierError, // the carrier failed: undo what was done, newest first — proved by agboss check
        toAction(RefundCardAction) // an undo without output: no .returns
          .onError(
            PaymentProviderError, // the refund itself failed: a person takes over; the stock still goes back
            toAction(NotifyFinanceAction)
              .toAction(ReleaseStockAction),
          )
          .toAction(ReleaseStockAction),
      )
      .returns(OrderShippedDto)
      .toAction(ConfirmOrderAction) // the commit point of the payment
      .toFinish(OrderShippedWorkflowFinish), // a finish commits what is still open (the reservation)

    action(ReleaseStockAction) // reached from two places: its own path
      .toFinish(OrderFailedWorkflowFinish),
  ],
})
export class OrderWorkflow {}
```

A failed join undoes its finished branches by itself — the side path cannot, the join's values never
reach it:

```ts file=src/trip/dto/trip-request.dto.ts
import { Text } from "@agboss/core/dto";

export class TripRequestDto {
  @Text({ prompt: "where the trip goes" })
  destination!: string;
}
```

```ts file=src/trip/dto/flight-booking.dto.ts
import { Text } from "@agboss/core/dto";

export class FlightBookingDto {
  @Text({ prompt: "the flight booking's id" })
  bookingId!: string;
}
```

```ts file=src/trip/dto/hotel-booking.dto.ts
import { Text } from "@agboss/core/dto";

export class HotelBookingDto {
  @Text({ prompt: "the hotel booking's id" })
  bookingId!: string;
}
```

```ts file=src/trip/dto/trip-booked.dto.ts
import { Text } from "@agboss/core/dto";

export class TripBookedDto {
  @Text({ prompt: "both booking ids" })
  summary!: string;
}
```

```ts file=src/trip/errors/booking-failed.error.ts


export class BookingFailedError extends Error {}
```

```ts file=src/trip/workflows/trip/trip.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { TripRequestDto } from "../../dto/trip-request.dto.js";

@WorkflowStart({ name: "trip-workflow-start", description: "A trip to book", input: TripRequestDto })
export class TripWorkflowStart {}
```

```ts file=src/trip/actions/cancel-flight.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { FlightBookingDto } from "../dto/flight-booking.dto.js";

@Action({ name: "cancel-flight-action", description: "Cancels the flight", input: { flight: FlightBookingDto } })
export class CancelFlightAction implements ActionHandler<CancelFlightAction> {
  async execute(input: InputOf<CancelFlightAction>): Promise<void> {
    await Promise.resolve(input.flight.value.bookingId);
  }
}
```

```ts file=src/trip/actions/cancel-hotel.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf } from "@agboss/core";
import { HotelBookingDto } from "../dto/hotel-booking.dto.js";

@Action({ name: "cancel-hotel-action", description: "Cancels the hotel", input: { hotel: HotelBookingDto } })
export class CancelHotelAction implements ActionHandler<CancelHotelAction> {
  async execute(input: InputOf<CancelHotelAction>): Promise<void> {
    await Promise.resolve(input.hotel.value.bookingId);
  }
}
```

```ts file=src/trip/actions/book-flight.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { FlightBookingDto } from "../dto/flight-booking.dto.js";
import { TripRequestDto } from "../dto/trip-request.dto.js";
import { CancelFlightAction } from "./cancel-flight.action.js";

@Action({ name: "book-flight-action", description: "Books the flight", input: { request: TripRequestDto }, output: FlightBookingDto, compensateWith: CancelFlightAction })
export class BookFlightAction implements ActionHandler<BookFlightAction> {
  execute(input: InputOf<BookFlightAction>): Promise<OutputOf<BookFlightAction>> {
    return Promise.resolve({ bookingId: `flight-${input.request.value.destination}` });
  }
}
```

```ts file=src/trip/actions/book-hotel.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { HotelBookingDto } from "../dto/hotel-booking.dto.js";
import { TripRequestDto } from "../dto/trip-request.dto.js";
import { CancelHotelAction } from "./cancel-hotel.action.js";

@Action({ name: "book-hotel-action", description: "Books the hotel", input: { request: TripRequestDto }, output: HotelBookingDto, compensateWith: CancelHotelAction })
export class BookHotelAction implements ActionHandler<BookHotelAction> {
  execute(input: InputOf<BookHotelAction>): Promise<OutputOf<BookHotelAction>> {
    return Promise.resolve({ bookingId: `hotel-${input.request.value.destination}` });
  }
}
```

```ts file=src/trip/workflows/trip/trip-not-booked.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { TripRequestDto } from "../../dto/trip-request.dto.js";

@WorkflowFinish({ name: "trip-not-booked-workflow-finish", description: "Not booked", output: TripRequestDto })
export class TripNotBookedWorkflowFinish {}
```

```ts file=src/trip/workflows/trip/trip-booked.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import type { FinishHandler, InputOf, OutputOf } from "@agboss/core";
import { FlightBookingDto } from "../../dto/flight-booking.dto.js";
import { HotelBookingDto } from "../../dto/hotel-booking.dto.js";
import { TripBookedDto } from "../../dto/trip-booked.dto.js";

@WorkflowFinish({
  name: "trip-booked-workflow-finish",
  description: "Both bookings",
  input: { flight: FlightBookingDto, hotel: HotelBookingDto },
  output: TripBookedDto,
})
export class TripBookedWorkflowFinish implements FinishHandler<TripBookedWorkflowFinish> {
  finish(input: InputOf<TripBookedWorkflowFinish>): OutputOf<TripBookedWorkflowFinish> {
    return { summary: `${input.flight.value.bookingId} + ${input.hotel.value.bookingId}` };
  }
}
```

```ts file=src/trip/workflows/trip/trip.workflow.ts
import { Workflow, start, toFinish } from "@agboss/core";
import { BookFlightAction } from "../../actions/book-flight.action.js";
import { BookHotelAction } from "../../actions/book-hotel.action.js";
import { FlightBookingDto } from "../../dto/flight-booking.dto.js";
import { HotelBookingDto } from "../../dto/hotel-booking.dto.js";
import { TripRequestDto } from "../../dto/trip-request.dto.js";
import { BookingFailedError } from "../../errors/booking-failed.error.js";
import { TripBookedWorkflowFinish } from "./trip-booked.workflow-finish.js";
import { TripNotBookedWorkflowFinish } from "./trip-not-booked.workflow-finish.js";
import { TripWorkflowStart } from "./trip.workflow-start.js";

@Workflow({
  name: "trip-workflow",
  version: "1.0.0",
  flow: [
    start(TripWorkflowStart)
      .returns(TripRequestDto)
      .toParallelActions(BookFlightAction, BookHotelAction)
      .join()
      .onJoinError(
        BookingFailedError, // the hotel failed: the finished flight is cancelled before this path runs
        toFinish(TripNotBookedWorkflowFinish),
      )
      .returns(FlightBookingDto)
      .returns(HotelBookingDto)
      .toFinish(TripBookedWorkflowFinish), // the finish commits both bookings
  ],
})
export class TripWorkflow {}
```

What the check proves, and the codes:

| Code                                     | When                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `[action.compensator-not-an-action]`     | `compensateWith` names something that is not an `@Action`                                   |
| `[action.committer-not-an-action]`       | `committedBy` names something that is not an `@Action`                                      |
| `[action.self-compensation]`             | an action undoes itself                                                                     |
| `[action.compensator-compensates]`       | an undo action declares its own `compensateWith` (no chains)                                |
| `[action.invalid-compensator-input]`     | the undo reads a field not on the path right after its action                               |
| `[action.committer-without-compensator]` | `committedBy` without `compensateWith` — it has no effect                                   |
| `[flow.uncompensated-action]`            | a side path after an undoable action reaches a finish without its undo                      |
| `[flow.compensation-out-of-order]`       | a side path undoes an older action before a newer one                                       |
| `[flow.uncommitted-action]`              | with `committedBy`, a path from the action reaches a finish with neither committer nor undo |
| `[flow.committer-unreachable]`           | no path from the action reaches its committer (a warning; an error under `--strict`)        |

At run time `result.compensations` lists every undo that ran — `CompensationRecord { compensated,
compensator, reason, status, error?, startedAt, endedAt }` with `CompensationReason` (`SidePath`,
`JoinFailed`, `ExecutionFailed`, `ExecutionCancelled`) and `CompensationStatus` (`Compensated`,
`Failed`); observers get `onCompensationStart` / `onCompensationEnd` for the automatic ones; tests
assert with `expect(result).toHaveCompensated(BookFlightAction, { by: CancelFlightAction, reason:
CompensationReason.JoinFailed })` (reference 10). `npx agboss describe` prints
`charge-order-card-action  compensateWith refund-card-action · committedBy confirm-order-action`.

## 9. Errors: what `.onError` can catch

`.onError(E, …)` matches by class through the cause chain: a subclass is caught by its parent's side
path, and so is an error _caused_ by `E` (an action's own exception is the `cause` of its
`ActionFailedError`). The most specific handler wins; two for one class on one step are
`[flow.duplicate-error-handler]`. Without a handler the execution fails.

| Class (`code`)                                                                                  | Thrown when                                                                    | Side path may use a model?         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `PaidStepError` (`step`)                                                                        | the parent of a step's failures that cost money (rows below)                   | yes                                |
| ↳ `StepFailedError` (`step.failed`)                                                             | a step's own failure — names `component`, `nodeId`, `visitNumber`, `itemIndex` | yes                                |
| ↳↳ `AgentFailedError` (`step.agent`)                                                            | an agent's model call or loop failed                                           | yes                                |
| ↳↳↳ `AgentAnswerInvalidError` (`step.agent.invalid-answer`)                                     | its answers stayed invalid after the retries                                   | yes                                |
| ↳↳↳ `QualityGateError` (`step.agent.quality-gate`)                                              | its judges rejected the answer after `maxRetries`                              | yes                                |
| ↳↳ `ActionFailedError` (`step.action`)                                                          | an action threw (the original as `cause`)                                      | yes                                |
| ↳↳ `RouterFailedError` (`step.router`) ↳ `RouterDecisionError` (`step.router.invalid-decision`) | `route()` threw / the model failed; an answer outside the routes               | yes                                |
| ↳↳ `GuardFailedError` (`step.guard`)                                                            | a guardrail's model did not answer (fails closed)                              | yes                                |
| ↳↳ `ArbiterError` (`step.arbiter`), `QuorumNotReachedError` (`step.quorum`)                     | an arbiter threw; too few counted answers (`.onJoinError`)                     | yes                                |
| ↳↳ `ChildExecutionFailedError` (`step.child`)                                                   | a child's uncaught error (its `cause`)                                         | yes, unless the cause is a limit   |
| ↳ `GuardrailBlockedError` (`guardrail.blocked`)                                                 | a guardrail said yes; `refusal` is the text to send instead                    | yes                                |
| ↳ `PiiRefusedError` (`pii.refused`)                                                             | a `blockWithRefusal()` PII rule matched                                        | yes                                |
| `LimitExceededError` (`limit`)                                                                  | the parent of every limit                                                      | **no** — actions and finishes only |
| ↳ `StepsLimitExceededError` (`limit.steps`)                                                     | the workflow's `maxSteps`                                                      | no                                 |
| ↳ `VisitsLimitExceededError` (`limit.visits`)                                                   | a node's `maxVisits`                                                           | no                                 |
| ↳ `BudgetExceededError` (`limit.budget`)                                                        | a `@Budget`'s `maxSpend()`                                                     | no                                 |
| ↳ `DepthLimitExceededError` (`limit.depth`)                                                     | a recursive launch past `maxDepth` (inside `ChildExecutionFailedError`)        | no                                 |
| `ExecutionCancelledError` (`execution.cancelled`)                                               | `app.cancel` or the caller's `signal` — never taken by a side path             | —                                  |
| `ApplicationStoppingError` (`app.stopping`)                                                     | `app.close()` interrupted it — never taken                                     | —                                  |
| `CompensationFailedError` (`compensation.failed`)                                               | an automatic undo failed — never taken                                         | —                                  |

`ToolTimeoutError` (`tool.timeout`) never reaches the flow: a tool call past its `timeout` is read by
its agent's model as the tool's error, like any tool error. All of them are `AGBossError`s.

Your own domain errors are plain `Error` subclasses thrown by services; catch them by class
(`.onError(CarrierError, …)`): the framework's wrapper keeps them as `cause`. A side path that can
catch a limit — `LimitExceededError`, a subclass, or a parent such as `AGBossError` or `Error` —
leads only to actions and finishes (`[graph.limit-handler-uses-model]`): nothing pays past a limit.

## 10. Limits the flow is checked against

- `@Workflow({ maxSteps })` — agent and router visits per execution, default (agents + routers) × 3.
  `[limits.max-steps-too-low]`: no finish fits in a hand-set `maxSteps`, or the default cannot hold a
  per-item launch's worst case; `[limits.branch-exceeds-max-steps]`: every path through a node is
  longer; `[limits.max-steps-unused]`: a workflow without agents or routers sets it.
- `maxVisits` on an agent or router — every node on a cycle needs one on the cycle
  (`[graph.cycle-without-max-visits]`).
- A path nested more than four branches deep warns `[flow.path-too-deep]`; a node reached with too
  many scopes is `[flow.analysis-too-large]` — move a branch into a child workflow
  (`npx agboss generate workflow <name>-workflow`).

## Pitfalls

- `start(A).returns(B).toFinish(C)` on one line — one call per line, always.
- `.onError` after `.returns(…)`: it goes right after the step that throws, before its `.returns`.
- `.onError` after a join, or `.onJoinError` after a single step — the other one does not compile.
- Continuing a shared node inline in two places (`[flow.shared-node-inline]`) — give it its own path.
- A model router after an agent that already knows the outcome: return `oneOf(…)` and `switch`.
- `executionContext.depth` read by a prompt — no model sees it; a domain level is an input field.
- An undo that is an agent, or an undo that reads what the action never had — the undo is an
  `@Action` over what the path holds right after its action.
