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
`@stylistic/newline-per-chained-call` fails `onStart(A).toAgent(B)` on one line.

| Form                                                                                        | What it says                                                                                                                                                                                                                                      | Rules it can hit                                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `onStart(S)`                                                                                | where an execution begins (a `@WorkflowStart`)                                                                                                                                                                                                    | `[graph.no-workflow-start]`, `[graph.unreachable-node]`                                                      |
| `onAgent(X)` / `onRouter(R)` / `onAction(A)` / `onWorkflow(W)`                              | the own path of a node reached from two or more places, written once                                                                                                                                                                              | `[flow.shared-node-inline]`, `[flow.single-entry-own-path]`                                                  |
| (no `.returns`)                                                                             | what a step gives is derived from its declaration: a start its `input` (one value per field of a map), a step its `output`, a text agent its reply, a join the branches' values                                                                   | `[flow.unused-output]`, `[input.missing-on-path]`                                                            |
| `.toAgent(X)` `.toAction(A)` `.toRouter(R)` `.toWorkflow(W)` `.toFinish(F)`                 | the next step, by its kind (another kind does not compile)                                                                                                                                                                                        | `[graph.wrong-kind]`, `[graph.dead-end]`, `[graph.next-after-workflow-finish]`                               |
| `.toRouter(R).onRoute(toAgent(X)…).onRoute(…)`                                              | the router's choice: exactly one `.onRoute(…)` per `@Router` route, each continued to its end                                                                                                                                                     |
| `.toOneOf([toAction(A)…, toFinish(F)])`                                                     | a side path per variant of a `oneOf` output; each takes the variant its first step reads as input, no DTO in the flow                                                                                                                             | `[flow.one-of-not-exhaustive]`, `[flow.one-of-ambiguous]`                                                    |
| `.toWorkflow(W).onFinish(WFinish, toAction(A)…)`                                            | one path per finish of a child workflow with two or more finishes, named by the `@WorkflowFinish` class (never a DTO), every finish once                                                                                                          | `[flow.one-of-not-exhaustive]`, `[flow.one-of-ambiguous]`                                                    |
| `.onError(E, side path)`                                                                    | right after the step that throws: what happens when it throws `E`                                                                                                                                                                                 | `[flow.duplicate-error-handler]`, `[graph.limit-handler-uses-model]`, `[flow.uncompensated-action]`          |
| side-path starters `toAction` `toAgent` `toRouter` `toExternalTask` `toWorkflow` `toFinish` | the first step of a side path (functions, not methods)                                                                                                                                                                                            | as for the steps                                                                                             |
| `.inParallel([toAgent(A), toAction(X).onError(E, skip()), …], { maxConcurrency })`          | a launch of branches of any kind (`toAgent`, `toAction`, `toExternalTask`, `toWorkflow`); `.onError(E, skip())` on a branch drops its failure from the join (its value is `optional(…)`)                                                          | `[launch.skip-differs]`                                                                                      |
| `toRouter(R).chooseMany([toAgent(A), toAgent(B)…])` inside `.inParallel([…])`               | a router picks which of its routes run (none, some or all; `[]` is an answer), siblings always run; a code router's `route()` returns the chosen classes, `routes: [A, () => B]` is a flat list                                                   | `[router.routes-mismatch]`                                                                                   |
| `.forEachItem(toAgent(A), { takeFirst: 4, maxConcurrency })` / `{ maxItems: 20 }`           | one run per item of the list the step before gives; `takeFirst` runs the first N and reports the rest dropped (`onLaunchItemsTruncated`), `maxItems` throws `LimitError.Items` before any branch and needs `.join().onError(LimitError.Items, …)` | `[launch.max-items-handler-required]`, `[launch.for-each-item-no-list]`                                      |
| `.join()` → `.onError(E, …)`                                                                | where a launch's values meet; a failed branch's side path                                                                                                                                                                                         | `[launch.unjoinable-output]`, `[launch.branch-outdates-sibling]`                                             |
| `.arbitratedBy(X)` → `.joinQuorum({ min, max, deadline })`                                  | count the accepted answers instead of waiting for all                                                                                                                                                                                             | `[flow.quorum-impossible]`, `[arbiter.*]`                                                                    |
| `.joinQuorumGroups({ deadline })` + `.onGroup([A, B], { priority: 1 }, subPath)`            | the first complete group (by priority) continues its own path                                                                                                                                                                                     | `[flow.quorum-impossible]`                                                                                   |
| `.toWorkflow(W)` / `route(W)` / `.forEachItem(toWorkflow(W), { takeFirst })`                | a child workflow: one, chosen by a router, or one per item                                                                                                                                                                                        | `[graph.no-matching-start]`, `[graph.ambiguous-start]`, `[graph.child-without-failure-finish]`               |
| `.toExternalTask(Q)` / `onExternalTask(Q)`                                                  | an external task's step (#659): reads its `input`, pauses on its channel, gives its `output` — `05-channels-and-human-in-the-loop.md`                                                                                                             | `[name.kind-suffix]` (`-external-task`), `[channel.wrong-tool]`, `[graph.cycle-without-max-visits]`          |
| `() => Self` + `@Workflow({ executionLimits: { maxDepth } })`                               | the workflow launches itself                                                                                                                                                                                                                      | `[graph.recursion-without-depth]`, `[graph.recursion-without-exit]`, `[graph.mutual-recursion]`              |
| `@Action({ compensateWith, committedBy })`                                                  | the action's undo and its commit point; side paths must run the undo                                                                                                                                                                              | `[action.*]`, `[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`, `[flow.uncommitted-action]` |

The wrappers (`agboss`, also re-exported by `@agboss/core/dto`): `listOf(XDto)`, `oneOf(A, B)`,
`optional(XDto)`, `historyOf(XDto, { maxPrevious })` (an input only).

Placement rules that hold everywhere:

- **One class is one node.** A class mentioned again is the same node (a loop, a merge). Two stages
  that look alike are two classes (`[flow.continuation-twice]`).
- **A node reached from one place is continued inline**; one reached from two or more places has its
  own path — `onAgent(X)…`, `onAction(A)…` — and every path into it ends at it.
- **Finishes are terminal and always inline**: `.toFinish(F)` or `route(F)`, from any number of places.
- **Position never carries meaning**: paths, routes and cases can be reordered.

## 1. A straight path, a start with several fields

A start's input is a DTO, a `listOf(…)` or a map of fields; `onStart(S)` gives each field. A node reads its `input` fields from the scope by class — never by position. An action
gets each field as the DTO itself (tracked: `Metadata.createdBy(field)` is the class that gave it).

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
import { Bool, Enum } from "@agboss/core/dto";

export class TriageDto {
  @Enum(["billing", "bug", "other"], { prompt: "the ticket's queue" })
  queue!: "billing" | "bug" | "other";

  @Bool({ prompt: "whether the ticket is urgent" })
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
import { Agent, optional, inline } from "@agboss/core";
import { CustomerDto } from "../../dto/customer.dto.js";
import { TicketDto } from "../../dto/ticket.dto.js";
import { TriageDto } from "../../dto/triage.dto.js";

@Agent({
  name: "ticket-triage-agent",
  description: "Sorts the ticket into a queue",
  prompt: inline("Sort the ticket into a queue; urgent when the customer cannot work."),
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
    const { queue } = input.triage; // the DTO itself; Metadata.createdBy(input.triage) is who made it
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
import { Workflow, optional, onStart, toAgent, toAction, toFinish, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TicketWorkflowStart) // a start's map of fields: one value per field
      .toAgent(TicketTriageAgent)
      .toAction(FileTicketAction) // reads ticket (from the start) and triage (from the agent)
      .toFinish(TicketFiledWorkflowFinish), // a finish is a pure boundary port: it hands back its output class
  ],
  executionLimits: { maxSteps: 2 },
})
export class TicketWorkflow {}
```

- What a step gives is its declared `output` (a start's `input`): nothing is written after it, and a step
  without `output` gives nothing. A step with a `oneOf(…)` output is branched by `.toOneOf([…])`
  (`[flow.one-of-not-exhaustive]` for a transition right after it).
- A value nobody reads is `[flow.unused-output]`; a required field no path brings is
  `[input.missing-on-path]`; an `optional(…)` field no path ever brings is `[input.never-produced]`.
- Two fields of one class in one node read the same value: `[flow.ambiguous-field]` — read it once,
  or with `historyOf(XDto)` (section 3).

## 2. A router's choice, a node reached from two places

`.toRouter(R).onRoute(…)` lists one `route(…)` per route of the `@Router` — exactly those
(`[router.routes-mismatch]`). A model router reads its `input` and picks by meaning; a code router's
`route(input)` returns a target, typed by its `routes`. A route's `target` is a class or a thunk of one,
`{ target: () => NoOrderWorkflowFinish }`: write the thunk when the class is declared below the router
or in a module that imports it back (a plain class there is a `ReferenceError`, the temporal dead zone);
`Route<R>` is the same type either way. A **text agent** (no `output`) leads only to a
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
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

@Agent({
  name: "order-intake-agent",
  description: "Turns the message into an order",
  prompt: inline("Read the order out of the message."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: CreditOrderDto,
})
export class OrderIntakeAgent {}
```

```ts file=src/credit/agents/credit-question/credit-question.agent.ts
import { Agent, inline } from "@agboss/core";

@Agent({
  name: "credit-question-agent",
  description: "Answers a question about credit terms",
  prompt: inline("Answer the question about our credit terms in two sentences."),
  model: "moonshotai/kimi-k2.6",
}) // a text agent: no output — it answers text
export class CreditQuestionAgent {}
```

```ts file=src/credit/agents/credit-approval/credit-approval.agent.ts
import { Agent, inline } from "@agboss/core";
import { CreditApprovalDto } from "../../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

@Agent({
  name: "credit-approval-agent",
  description: "Approves a large order",
  prompt: inline("Approve the order if the customer's history allows it."),
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
    const approvedBy: string = input.approval?.approvedBy ?? "auto";
    return Promise.resolve({ chargeId: `${input.order.customerId}:${approvedBy}:${key}` });
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

A decision model (Jev) is served by a decisions provider — a component naming one says so with `modelProvider`:

```ts file=src/model-providers/decisions.model-provider.ts
import { secret } from "@agboss/core";
import { DecisionsDriver, ModelCost, ModelProvider } from "@agboss/core/models";
import { seconds } from "@agboss/core/units";

@ModelProvider({
  name: "decisions-model-provider",
  description: "Jev and the other decision models, on OpenRouter's Decisions API",
  driver: DecisionsDriver({ baseUrl: "https://openrouter.ai/api/v1", apiKey: secret("OPENROUTER_API_KEY") }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
})
export class DecisionsModelProvider {}
```

```ts file=src/credit/routers/credit-desk/credit-desk.router.ts
import { DecisionsModelProvider } from "../../../model-providers/decisions.model-provider.js";
import { DecidedBy, Router, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CreditQuestionAgent } from "../../agents/credit-question/credit-question.agent.js";
import { OrderIntakeAgent } from "../../agents/order-intake/order-intake.agent.js";

@Router({
  name: "credit-desk-router",
  description: "Sends an order to intake, a question to the answering agent",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  modelProvider: DecisionsModelProvider,
  prompt: inline("Pick who handles the customer's message."),
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
import { DecidedBy, Router } from "@agboss/core";
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
  routes: [CreditApprovalAgent, ChargeOrderAction],
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  route(input: InputOf<CreditLimitRouter>): Route<CreditLimitRouter> {
    return input.order.total > APPROVAL_LIMIT ? CreditApprovalAgent : ChargeOrderAction;
  }
}
```

```ts file=src/credit/workflows/credit/credit.workflow.ts
import {
  Workflow,
  onAction,
  onStart,
  toFinish,
  toAction,
  toRouter,
  toAgent,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(CreditWorkflowStart)
      .toRouter(CreditDeskRouter)
      .onRoute(
        toAgent(OrderIntakeAgent)
          .toRouter(CreditLimitRouter)
          .onError(
            CreditServiceUnavailableError, // route() threw: caught through StepError.Router's cause
            toFinish(OrderHeldWorkflowFinish),
          )
          .onRoute(
            toAgent(CreditApprovalAgent)
              .toAction(ChargeOrderAction),
          )
          .onRoute(toAction(ChargeOrderAction)), // ends at the shared node
      )
      .onRoute(
        toAgent(CreditQuestionAgent)
          .toFinish(CreditAnswerWorkflowFinish), // a text agent → a WorkflowFinishTextDto finish
      ),

    // reached from two places (the approval and the limit router): its own path, written once
    onAction(ChargeOrderAction)
      .toFinish(OrderChargedWorkflowFinish),
  ],
  executionLimits: { maxSteps: 6 },
})
export class CreditWorkflow {}
```

- A route **to a finish** on a model router is worded as a stop instruction ("Stop and hand it over:
  …"), never "the answer is ready".
- A router that fails fails the run unless an `.onError(…)` right after it takes it: `StepError.Router`
  (the original as `cause`, so `.onError(CreditServiceUnavailableError, …)` catches it) or
  `StepError.RouterDecision` (an answer outside its routes; a `StepError.Router` too, never retried).
- `.onError` stands right after the step, before `.onRoute(…)`.
- A model router without `model` takes `defaults.router.model` (none anywhere: `[model.missing-provider]`); its `input`
  is never empty (`[router.empty-input]`); a route of a model router is `{ target, prompt }`
  (`[router.no-prompt]`), a code router's a class.

## 3. A branch by result, a loop, `historyOf`

An agent with `output: oneOf(A, B)` says which outcome it is; `.toOneOf([…])` has
one branch per variant. In a loop a new value outdates what was built from the old one, and
`historyOf(XDto, { maxPrevious })` reads the earlier versions. Every node on a
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
import { Agent, inline } from "@agboss/core";
import { CandidateShortlistDto } from "../../dto/candidate-shortlist.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-draft-agent",
  description: "Writes the first draft of the offer",
  prompt: inline("Write the offer for the candidate."),
  model: "moonshotai/kimi-k2.6",
  input: { shortlist: CandidateShortlistDto },
  output: OfferDraftDto,
})
export class OfferDraftAgent {}
```

```ts file=src/offer/agents/offer-reviewer/offer-reviewer.agent.ts
import { Agent, historyOf, oneOf, inline } from "@agboss/core";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../dto/draft-approved.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: inline("Approve the draft, or say what to change. Compare it with the earlier versions."),
  model: "moonshotai/kimi-k2.6",
  input: { draft: historyOf(OfferDraftDto, { maxPrevious: 2 }) }, // { current, previous } — the last two before
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
  executionLimits: { maxVisits: 4 },
})
export class OfferReviewerAgent {}
```

```ts file=src/offer/agents/offer-editor/offer-editor.agent.ts
import { Agent, inline } from "@agboss/core";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";

@Agent({
  name: "offer-editor-agent",
  description: "Rewrites the draft as asked",
  prompt: inline("Rewrite the draft so it meets the requested changes."),
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto, changes: ChangesRequestedDto },
  output: OfferDraftDto,
  executionLimits: { maxVisits: 3 },
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
    return Promise.resolve({ offerId: `${String(input.draft.text.length)}:${key}` });
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
    await Promise.resolve(input.shortlist.candidate);
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
import {
  LimitError,
  Workflow,
  onAgent,
  oneOf,
  onStart,
  toAction,
  toAgent,
  toFinish,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OfferWorkflowStart)
      .toAgent(OfferDraftAgent)
      .toAgent(OfferReviewerAgent), // the reviewer is reached from two places: its own path below

    onAgent(OfferReviewerAgent)
      .toOneOf([
        // the editor reads the requested changes: that tells this branch apart
        toAgent(OfferEditorAgent)
          .onError(
            LimitError.Visits, // the editor's maxVisits spent: a person takes over
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish),
          ) // a new draft: the old one and the changes about it are outdated
          .toAgent(OfferReviewerAgent),
        toAction(SendOfferAction)
          .toFinish(OfferSentWorkflowFinish),
      ]),
  ],
  executionLimits: { maxSteps: 12 },
})
export class OfferWorkflow {}
```

- **Outdating.** A new value in a slot outdates everything built from the older one: after the editor
  returns a new `OfferDraftDto`, the old draft and the `ChangesRequestedDto` about it are gone from the
  scope. A field that would read an outdated value on some path fails assembly with
  `[input.outdated-on-path]`.
- **`historyOf(XDto, { maxPrevious })`** is `{ current, previous }`, `previous` oldest first, at most
  `maxPrevious` (a positive integer, `[input.history-max-previous]`); it needs a current `XDto` on every path in.
- a `.toOneOf([…])` branch no variant is left for, or two reading one variant, is `[flow.one-of-ambiguous]`, a missing
  variant `[flow.one-of-not-exhaustive]`.

## 4. Parallel launches and joins

A launch runs several branches at once; `.join()` is where their values meet. Agents with
`.inParallel([…])`, actions with `.inParallel([…])` — never mixed. What the join gives:

| Branches                                                          | The join gives                            |
| ----------------------------------------------------------------- | ----------------------------------------- |
| an agent listed once                                              | `XDto`                                    |
| copies of one agent (`B, B`), two agents with one `output`        | `listOf(XDto)`                            |
| one target per item (right after a step giving `listOf(ItemDto)`) | `listOf(XDto)`, in the items' order       |
| a branch a router chooses, or a `skip()` drops                    | `optional(XDto)`                          |
| an action without `output`                                        | nothing: `.join()` goes on with `.to…(…)` |

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
import { Bool } from "@agboss/core/dto";

export class FactCheckDto {
  @Bool({ prompt: "whether every claim is supported" })
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
import { Agent, listOf, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ArticleSectionDto } from "../../dto/article-section.dto.js";

@Agent({
  name: "section-splitter-agent",
  description: "Splits the article into sections",
  prompt: inline("Split the article into its sections."),
  model: "moonshotai/kimi-k2.6",
  input: { article: WorkflowStartTextDto },
  output: listOf(ArticleSectionDto),
})
export class SectionSplitterAgent {}
```

```ts file=src/review/agents/section-reviewer/section-reviewer.agent.ts
import { Agent, inline } from "@agboss/core";
import { ArticleSectionDto } from "../../dto/article-section.dto.js";
import { SectionReviewDto } from "../../dto/section-review.dto.js";

@Agent({
  name: "section-reviewer-agent",
  description: "Reviews one section",
  prompt: inline("Say what to fix in this section."),
  model: "moonshotai/kimi-k2.6",
  input: { section: ArticleSectionDto }, // per item: reads the item's class
  output: SectionReviewDto,
})
export class SectionReviewerAgent {}
```

```ts file=src/review/agents/style-critic/style-critic.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { StyleNotesDto } from "../../dto/style-notes.dto.js";

@Agent({
  name: "style-critic-agent",
  description: "Checks the style",
  prompt: inline("Note what to change in the style."),
  model: "moonshotai/kimi-k2.6",
  input: { article: WorkflowStartTextDto },
  output: StyleNotesDto,
})
export class StyleCriticAgent {}
```

```ts file=src/review/agents/fact-checker/fact-checker.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { FactCheckDto } from "../../dto/fact-check.dto.js";

@Agent({
  name: "fact-checker-agent",
  description: "Checks the claims",
  prompt: inline("Check every claim of the article."),
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
    // a list field is one DTO per item
    return Promise.resolve({ notes: input.sections.map((review) => review.notes).join("\n") });
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
    const isSupported: boolean = input.facts.every((check) => check.isSupported);
    const plan: string = [input.style.notes, input.sections.notes, `facts ok: ${String(isSupported)}`].join("\n");
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
    await Promise.resolve(input.article.text.length);
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
    await Promise.resolve(input.article.text.length);
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
import {
  StepError,
  Workflow,
  listOf,
  onStart,
  toFinish,
  toAgent,
  toAction,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ArticleReviewWorkflowStart)
      .toAgent(SectionSplitterAgent)
      .forEachItem(toAgent(SectionReviewerAgent), { takeFirst: 20, maxConcurrency: 3 }) // one run per item
      .join() // one value per item, in the list's order
      .toAction(SectionNotesAction) // a join goes on with one .to…(…) — never straight into a launch
      .inParallel(
        [toAgent(StyleCriticAgent), toAgent(FactCheckerAgent), toAgent(FactCheckerAgent)],
        { maxConcurrency: 2 },
      )
      .join()
      .onError(
        StepError, // a branch failed (FailFast): the others were cancelled
        toFinish(ReviewIncompleteWorkflowFinish),
      ) // fact-checker-agent ran twice: a list
      .toAction(ReviewSummaryAction)
      .toFinish(ReviewSummaryWorkflowFinish),

    // side effects at once: actions without output give the join nothing to name
    onStart(ArticlePublishWorkflowStart)
      .inParallel([toAction(ArchiveArticleAction), toAction(IndexArticleAction)])
      .join() // actions without output: nothing to give
      .toFinish(ArticlePublishedWorkflowFinish), // reads the WorkflowStartTextDto from the path
  ],
  executionLimits: { maxSteps: 30 }, // the worst case: the splitter, 20 section reviews and three critics
})
export class ArticleReviewWorkflow {}
```

A **router in a launch** is a branch, `toRouter(R).chooseMany([…])`: it decides which of its routes
are launched (by each route's `prompt`), its siblings in `.inParallel([…])` run anyway.
`.onError(E, skip())` on a branch lets a failed branch drop out instead of failing the launch.

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
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { OrderLookupDto } from "../../dto/order-lookup.dto.js";

@Agent({
  name: "order-lookup-agent",
  description: "Looks the order up",
  prompt: inline("Say where the order is."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: OrderLookupDto,
})
export class OrderLookupAgent {}
```

```ts file=src/support/agents/refund-terms/refund-terms.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { RefundTermsDto } from "../../dto/refund-terms.dto.js";

@Agent({
  name: "refund-terms-agent",
  description: "Quotes the refund terms",
  prompt: inline("Quote the refund terms that apply."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: RefundTermsDto,
})
export class RefundTermsAgent {}
```

```ts file=src/support/agents/loyalty-offer/loyalty-offer.agent.ts
import { Agent, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferDto } from "../../dto/loyalty-offer.dto.js";

@Agent({
  name: "loyalty-offer-agent",
  description: "Finds an offer for the customer",
  prompt: inline("Find one offer for the customer."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: LoyaltyOfferDto,
})
export class LoyaltyOfferAgent {}
```

```ts file=src/support/agents/support-reply/support-reply.agent.ts
import { Agent, optional, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferDto } from "../../dto/loyalty-offer.dto.js";
import { OrderLookupDto } from "../../dto/order-lookup.dto.js";
import { RefundTermsDto } from "../../dto/refund-terms.dto.js";
import { SupportReplyDto } from "../../dto/support-reply.dto.js";

@Agent({
  name: "support-reply-agent",
  description: "Writes the reply from what was found",
  prompt: inline("Reply to the customer from the findings."),
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
import { DecisionsModelProvider } from "../../../model-providers/decisions.model-provider.js";
import { DecidedBy, Router, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { LoyaltyOfferAgent } from "../../agents/loyalty-offer/loyalty-offer.agent.js";
import { OrderLookupAgent } from "../../agents/order-lookup/order-lookup.agent.js";
import { RefundTermsAgent } from "../../agents/refund-terms/refund-terms.agent.js";

@Router({
  name: "support-launch-router",
  description: "Picks everyone the customer's message needs",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  modelProvider: DecisionsModelProvider,
  prompt: inline("Pick everyone needed to answer the customer's message."),
  input: { message: WorkflowStartTextDto },
  routes: [{ target: RefundTermsAgent, prompt: "The message is about a return" }], // the one the model decides
})
export class SupportLaunchRouter {}
```

```ts file=src/support/workflows/support-launch/support-launch.workflow.ts
import {
  StepError,
  Workflow,
  optional,
  onStart,
  skip,
  toAgent,
  toRouter,
  toFinish,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SupportLaunchWorkflowStart)
      .inParallel([
        toAgent(OrderLookupAgent), // always launched
        toAgent(LoyaltyOfferAgent)
          .onError(StepError, skip()), // may drop out
        toRouter(SupportLaunchRouter)
          .chooseMany([toAgent(RefundTermsAgent)]), // exactly its routes
      ])
      .join() // the router's route may not be launched
      .toAgent(SupportReplyAgent)
      .toFinish(SupportReplyWorkflowFinish),
  ],
})
export class SupportLaunchWorkflow {}
```

Launch rules:

- A launch is always followed by `.join()` (`[launch.join-required]`, a compile error too); after the
  join `.onError(E, …)` (the join's own handler; not offered between a launch and its join) — then exactly one `.to…(…)`: a
  second launch never follows a join directly (put a step between, as `section-notes-action` above).
- Per item: `.forEachItem(step, { takeFirst | maxItems })` right after a step whose output is
  `listOf(ItemDto)`; the target reads an `ItemDto` field (`[launch.item-not-read]`). With `takeFirst`
  the first items run and the rest are dropped, recorded (`result.launches`, `onLaunchItemsTruncated`);
  with `maxItems` more items throw `LimitError.Items`, handled by `.onError(LimitError.Items, …)` after the join.
- A branch is one step: a launched class continued anywhere else is `[launch.branch-continued]` —
  several steps per item are a child workflow (section 6).
- A branch sees the scope at the launch, its siblings' values only after the join; a branch renewing
  what a sibling read is `[launch.branch-outdates-sibling]`.
- A router in a launch is a branch: `toRouter(R).chooseMany([toAgent(A), …])`, the list the router's
  routes (`[router.routes-mismatch]`), each with its prompt on a model router (`[router.no-prompt]`).
  A code router's `route(input)` returns the targets to launch as a list, `[]` included.
- `maxConcurrency` is a sliding window; a failed branch aborts its siblings (`FailFast`); `Skip`
  drops only a `StepError`; `app.cancel` cancels the whole execution, never a branch outcome.

## 5. Quorums, groups and arbiters

After `.inParallel([…])` (or `.inParallel([toAgent(…)])`) a join may count answers instead of waiting for
all. One `@Arbiter` class — `.arbitratedBy(A)`, once per launch — decides whether an answer counts;
how it decides (code, model, or code that asks its own model through `ArbiterModel`) lives in that
class, never in the flow: no `and` / `or` of arbiters, no `anyOf`. A method takes the answer of its
targets — `ArbiterAnswerOf<typeof A>` is one target's, `ArbitratedAnswerOf<[typeof A, typeof B]>` the union.

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
import { Bool } from "@agboss/core/dto";

export class PanelVerdictDto {
  @Bool({ prompt: "whether to hire" })
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
import { Agent, inline } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "skills-panel-agent",
  description: "Scores the technical skills",
  prompt: inline("Score the technical skills from 1 to 10."),
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class SkillsPanelAgent {}
```

```ts file=src/panel/agents/culture-panel/culture-panel.agent.ts
import { Agent, inline } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "culture-panel-agent",
  description: "Scores the team fit",
  prompt: inline("Score the team fit from 1 to 10."),
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class CulturePanelAgent {}
```

```ts file=src/panel/agents/risk-panel/risk-panel.agent.ts
import { Agent, inline } from "@agboss/core";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";

@Agent({
  name: "risk-panel-agent",
  description: "Scores the hiring risk",
  prompt: inline("Score the hiring risk from 1 (high) to 10 (low)."),
  model: "moonshotai/kimi-k2.6",
  input: { candidate: PanelCandidateDto },
  output: PanelScoreDto,
})
export class RiskPanelAgent {}
```

```ts file=src/panel/agents/panel-verdict/panel-verdict.agent.ts
import { Agent, listOf, inline } from "@agboss/core";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";
import { PanelVerdictDto } from "../../dto/panel-verdict.dto.js";

@Agent({
  name: "panel-verdict-agent",
  description: "Decides from the counted scores",
  prompt: inline("Decide whether to hire from the scores."),
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
import { Arbiter, Arbitrate, type ArbitratedAnswerOf } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

// by code: @Arbitrate(…targets) methods covering every target of the launch once; the name is yours
@Arbiter({ name: "score-range-arbiter" })
export class ScoreRangeArbiter {
  @Arbitrate(SkillsPanelAgent, CulturePanelAgent, RiskPanelAgent)
  isInRange(
    answer: ArbitratedAnswerOf<
      [typeof SkillsPanelAgent, typeof CulturePanelAgent, typeof RiskPanelAgent]
    >,
  ): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}
```

```ts file=src/panel/arbiters/reasoned-score/reasoned-score.arbiter.ts
import { DecisionsModelProvider } from "../../../model-providers/decisions.model-provider.js";
import { Arbiter, inline } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

// by model: one criterion per target of the launch
@Arbiter({
  name: "reasoned-score-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: DecisionsModelProvider,
  prompt: inline("Count an answer only if it meets the criterion of the agent that gave it."),
  criteria: [
    { target: SkillsPanelAgent, prompt: "The reason names a concrete technical skill" },
    { target: CulturePanelAgent, prompt: "The reason names a concrete trait of the team" },
    { target: RiskPanelAgent, prompt: "The reason names a concrete risk" },
  ],
})
export class ReasonedScoreArbiter {}
```

A code arbiter that lists `ArbiterModel` in `deps` decides what it can at `$0` and asks its own model
(`model`, resolved like every model: its provider, its workflow's, its application's) only where it
must — one class for the whole rule, so the flow names _which_ rule applies, never how it escalates:

```ts file=src/panel/arbiters/panel-score/panel-score.arbiter.ts
import { DecisionsModelProvider } from "../../../model-providers/decisions.model-provider.js";
import { Arbiter, ArbiterModel, Arbitrate, Decision, type ArbitratedAnswerOf } from "@agboss/core";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";

@Arbiter({
  name: "panel-score-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: DecisionsModelProvider,
  deps: [ArbiterModel],
})
export class PanelScoreArbiter {
  constructor(private readonly arbiterModel: ArbiterModel) {}

  @Arbitrate(SkillsPanelAgent, CulturePanelAgent, RiskPanelAgent)
  async isCounted(
    answer: ArbitratedAnswerOf<
      [typeof SkillsPanelAgent, typeof CulturePanelAgent, typeof RiskPanelAgent]
    >,
  ): Promise<boolean> {
    if (answer.score < 1 || answer.score > 10) return false; // code, `$0`
    if (answer.reason.length > 200) return true; // code, `$0`
    const read = await this.arbiterModel.decide({
      state: `Score ${String(answer.score)}: ${answer.reason}`,
      questions: { counts: Decision.boolean("The reason names something concrete") },
    });
    return read.counts.probability > 0.7; // budget-checked and charged as arbiter:panel-score-arbiter
  }
}
```

```ts file=src/panel/workflows/panel/panel.workflow.ts
import { StepError, Workflow, listOf, onStart, toAgent, toFinish, Ttl } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CulturePanelAgent } from "../../agents/culture-panel/culture-panel.agent.js";
import { PanelVerdictAgent } from "../../agents/panel-verdict/panel-verdict.agent.js";
import { RiskPanelAgent } from "../../agents/risk-panel/risk-panel.agent.js";
import { SkillsPanelAgent } from "../../agents/skills-panel/skills-panel.agent.js";
import { PanelScoreArbiter } from "../../arbiters/panel-score/panel-score.arbiter.js";
import { PanelCandidateDto } from "../../dto/panel-candidate.dto.js";
import { PanelScoreDto } from "../../dto/panel-score.dto.js";
import { PanelVerdictDto } from "../../dto/panel-verdict.dto.js";
import { PanelUndecidedWorkflowFinish } from "./panel-undecided.workflow-finish.js";
import { PanelVerdictWorkflowFinish } from "./panel-verdict.workflow-finish.js";
import { PanelWorkflowStart } from "./panel.workflow-start.js";

@Workflow({
  name: "panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel([toAgent(SkillsPanelAgent), toAgent(CulturePanelAgent), toAgent(RiskPanelAgent)])
      .arbitratedBy(PanelScoreArbiter) // one arbiter; its code asks its own model only where it must
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) }) // two accepted answers are enough
      .onError(StepError.QuorumNotReached, toFinish(PanelUndecidedWorkflowFinish)) // one output class from several agents: a list, in counting order
      .toAgent(PanelVerdictAgent)
      .toFinish(PanelVerdictWorkflowFinish),
  ],
})
export class PanelWorkflow {}
```

A quorum's `deadline` is `seconds()` / `minutes()` / `hours()`, or working time — `deadline: workDays(5), calendar: CorporateWorkingCalendar` (a `@WorkingCalendar` class; `[calendar.required-for-working-duration]` without it). The calendar is asked once at dispatch; if it fails, the join's `.onError(PauseError.WorkingCalendar, …)` takes it.

Groups — `.joinQuorumGroups({ deadline })`, its `.onError(…)` right after it (never after a group), then
one `.onGroup([targets], { priority }?, subPath)` per group (at least one): the first complete group, by
priority (1 is the highest), continues **its own** path; nothing follows the groups but more `.onGroup(…)`s:

```ts file=src/deal/dto/deal.dto.ts
import { Text } from "@agboss/core/dto";

export class DealDto {
  @Text({ prompt: "the deal's terms" })
  terms!: string;
}
```

```ts file=src/deal/dto/legal-review.dto.ts
import { Bool } from "@agboss/core/dto";

export class LegalReviewDto {
  @Bool({ prompt: "whether the terms are legal" })
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
import { Bool } from "@agboss/core/dto";

export class FastScreenDto {
  @Bool({ prompt: "whether the deal is obviously bad" })
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
import { Agent, inline } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";
import { LegalReviewDto } from "../../dto/legal-review.dto.js";

@Agent({ name: "deal-legal-agent", description: "Checks the law", prompt: inline("Check the terms against the law."), model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: LegalReviewDto })
export class DealLegalAgent {}
```

```ts file=src/deal/agents/deal-critic/deal-critic.agent.ts
import { Agent, inline } from "@agboss/core";
import { DealCritiqueDto } from "../../dto/deal-critique.dto.js";
import { DealDto } from "../../dto/deal.dto.js";

@Agent({ name: "deal-critic-agent", description: "Finds a weakness", prompt: inline("Name the deal's worst weakness."), model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: DealCritiqueDto })
export class DealCriticAgent {}
```

```ts file=src/deal/agents/deal-screen/deal-screen.agent.ts
import { Agent, inline } from "@agboss/core";
import { DealDto } from "../../dto/deal.dto.js";
import { FastScreenDto } from "../../dto/fast-screen.dto.js";

@Agent({ name: "deal-screen-agent", description: "Screens fast", prompt: inline("Say whether the deal is obviously bad."), model: "moonshotai/kimi-k2.6", input: { deal: DealDto }, output: FastScreenDto })
export class DealScreenAgent {}
```

```ts file=src/deal/agents/deal-report/deal-report.agent.ts
import { Agent, listOf, inline } from "@agboss/core";
import { DealCritiqueDto } from "../../dto/deal-critique.dto.js";
import { DealReportDto } from "../../dto/deal-report.dto.js";
import { LegalReviewDto } from "../../dto/legal-review.dto.js";

@Agent({
  name: "deal-report-agent",
  description: "Writes the full review",
  prompt: inline("Write the review from the legal check and the critiques."),
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
import { StepError, Workflow, listOf, onStart, toAgent, toFinish, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DealWorkflowStart)
      .inParallel([
        toAgent(DealLegalAgent),
        toAgent(DealCriticAgent),
        toAgent(DealCriticAgent),
        toAgent(DealScreenAgent),
      ])
      .joinQuorumGroups({ deadline: minutes(1) })
      .onError(StepError.QuorumNotReached, toFinish(DealUnreviewedWorkflowFinish))
      .onGroup(
        [DealLegalAgent, DealCriticAgent], // deal-critic-agent is launched twice: a list, even of one
        { priority: 1 },
        toAgent(DealReportAgent)
          .toFinish(DealReportWorkflowFinish),
      )
      .onGroup([DealScreenAgent], { priority: 2 }, toFinish(DealScreenedWorkflowFinish)),
  ],
})
export class DealWorkflow {}
```

Quorum rules:

- `.arbitratedBy(X)` stands between the launch and the quorum (`.arbitratedBy(…).join()` does not compile), once per launch; after `.forEachItem(…)` only `.joinQuorum(…)` follows (no groups).
- A code arbiter's `@Arbitrate(…targets)` methods cover every target class of the launch exactly
  once — `[arbiter.unhandled-target]`, `[arbiter.unknown-target]`, `[arbiter.duplicate-target]`; a
  void `@Action` has nothing to judge (`[arbiter.branch-has-no-output]`); an undecorated class is
  `[arbiter.not-an-arbiter]`.
- `.joinQuorum({ min })` with `min` below the agents launched makes a single answer
  `optional(XDto)` (a step that requires it is `[input.missing-on-path]`); `min` above what can run, or a group that can
  never complete, is `[flow.quorum-impossible]`.
- At run time each answer is `BranchVerdict.Counted`, `Rejected` or `Surplus`; once the quorum is
  decided the rest is cancelled (`BranchStatus.Cancelled`). A quorum not reached is
  `StepError.QuorumNotReached` into `.onError(…)`; an arbiter that throws is `StepError.Arbiter`. The time
  a branch waits for a tree slot does not count against the `deadline`.

## 6. Child workflows

Any `@Workflow` of the application can be a step: `.toWorkflow(W)` (one child), `route(W)` (a router
picks it), `.forEachItem(toWorkflow(W), { takeFirst: maxItems })` (one child per item), `onWorkflow(W)` (its own path),
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
import { Agent, oneOf, inline } from "@agboss/core";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorDto } from "../../dto/vendor.dto.js";

@Agent({
  name: "vendor-checker-agent",
  description: "Scores a vendor, or rejects it",
  prompt: inline("Score the vendor from 1 to 10, or reject it with a reason."),
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
    return Promise.resolve({ name: input.vendor.name });
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
import {
  StepError,
  Workflow,
  oneOf,
  onStart,
  toAction,
  toAgent,
  toFinish,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(VendorCheckWorkflowStart)
      .toAgent(VendorCheckerAgent)
      .onError(
        StepError, // the child catches its own failure: one more result class for its parent
        toAction(MarkVendorFailedAction)
          .toFinish(VendorCheckFailedWorkflowFinish),
      )
      .toOneOf([toFinish(VendorScoredWorkflowFinish), toFinish(VendorRejectedWorkflowFinish)]),
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
import { Agent, listOf, inline } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { VendorDto } from "../../dto/vendor.dto.js";

@Agent({
  name: "vendor-finder-agent",
  description: "Finds vendors for the request",
  prompt: inline("List the vendors that can deliver the request."),
  model: "moonshotai/kimi-k2.6",
  input: { request: WorkflowStartTextDto },
  output: listOf(VendorDto),
})
export class VendorFinderAgent {}
```

```ts file=src/vendor/agents/vendor-ranker/vendor-ranker.agent.ts
import { Agent, listOf, oneOf, inline } from "@agboss/core";
import { VendorCheckFailedDto } from "../../dto/vendor-check-failed.dto.js";
import { VendorRankingDto } from "../../dto/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";

@Agent({
  name: "vendor-ranker-agent",
  description: "Ranks the checked vendors",
  prompt: inline("Rank the scored vendors; mention the rejected and failed ones."),
  model: "moonshotai/kimi-k2.6",
  input: { checks: listOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto) },
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
import { Workflow, listOf, oneOf, onStart, toAgent, toFinish, toWorkflow, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    // one child per item: each VendorDto enters vendor-check-workflow-start; the join is the list
    // of the child's finish output classes
    onStart(VendorScreeningWorkflowStart)
      .toAgent(VendorFinderAgent)
      .forEachItem(toWorkflow(VendorCheckWorkflow), { takeFirst: 20, maxConcurrency: 3 })
      .join() // one polymorphic list
      .toAgent(VendorRankerAgent)
      .toFinish(VendorRankingWorkflowFinish),
  ],
})
export class VendorScreeningWorkflow {}
```

```ts file=src/vendor/workflows/single-vendor/single-vendor.workflow.ts
import {
  StepError,
  Workflow,
  oneOf,
  onStart,
  toFinish,
  toWorkflow,
  Ttl,
} from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SingleVendorWorkflowStart)
      .toWorkflow(VendorCheckWorkflow)
      .onError(
        StepError.Child, // an uncaught error of the child (its step, maxSteps, maxVisits)
        toFinish(VendorCrashedWorkflowFinish),
      )
      .toOneOf([
        toFinish(SingleVendorScoredWorkflowFinish),
        toFinish(SingleVendorRejectedWorkflowFinish),
        toFinish(SingleVendorFailedWorkflowFinish),
      ]),
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
    return Promise.resolve({ receipt: `card:${input.payment.paymentId}` });
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
    return Promise.resolve({ receipt: `invoice:${input.payment.paymentId}` });
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
import { Workflow, onStart, toAction, toFinish, Ttl } from "@agboss/core";
import { SendInvoiceAction } from "../../actions/send-invoice.action.js";
import { PaymentDoneDto } from "../../dto/payment-done.dto.js";
import { PaymentRequestDto } from "../../dto/payment-request.dto.js";
import { InvoicedWorkflowFinish } from "./invoiced.workflow-finish.js";
import { PaymentRecoveryWorkflowStart } from "./payment-recovery.workflow-start.js";

@Workflow({
  name: "payment-recovery-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaymentRecoveryWorkflowStart)
      .toAction(SendInvoiceAction)
      .toFinish(InvoicedWorkflowFinish),
  ],
})
export class PaymentRecoveryWorkflow {}
```

```ts file=src/payment/workflows/pay/pay.workflow.ts
import { StepError, Workflow, onStart, toWorkflow, toAction, toFinish, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PayWorkflowStart)
      .toAction(ChargeCardAction)
      .onError(
        StepError, // the charge failed: the recovery workflow takes it from here
        toWorkflow(PaymentRecoveryWorkflow)
          .toFinish(RecoveredWorkflowFinish),
      )
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
- **Errors**: `.onError(E, …)` right after `.toWorkflow(W)` or `onWorkflow(W)`; `.onError(E, …)`
  right after a per-item join. An uncaught error of the child — its step, its `maxSteps`, a node's
  `maxVisits` — is the parent's `StepError.Child` (a `StepError`: `cause`,
  `childExecutionId`, `itemIndex`, `workflow`), so its handler may be an agent. An exhausted budget,
  a cancel and `ExecutionError.CompensationFailed` stop the whole tree as they are — never wrapped.
- **Soft failure per item**: a child that catches its own error and ends at a failure finish gives
  one more result class; a per-item child with no finish reachable from an `.onError` side path warns
  `[graph.child-without-failure-finish]` (one failed item would cancel all the others).
- A child need not be listed in `@Application({ workflows })`; it runs alone through its own starts too.
  It spends from the root's budgets; its own execution budget applies only when it runs as the root.
- **Where it runs (#333)**: on its parent's instance by default; `@Workflow({ placement:
ChildPlacement.AnyWorker })` on the child (never on the flow; else `@Application({ defaults: { workflows: {
placement } } })`; `OtherWorker` excludes the launching instance) queues it for a live worker with a free
  step slot (list `SqliteChildExecutionQueueRepository`, else `[application.in-memory-child-queue]`);
  pauses, `app.resume`, and per-child crash recovery
  work across instances on `<parentThreadId>/child/<id>`.

## 7. Recursion: `() => Self`

A workflow launches itself with a thunk of its own class (the class does not exist yet when its
decorator's arguments are evaluated; the thunk is read at assembly). `@Workflow({ executionLimits: { maxDepth } })` is required; on the last level
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
import { Agent, oneOf, inline } from "@agboss/core";
import { TopicReportDto } from "../../dto/topic-report.dto.js";
import { TopicTooBroadDto } from "../../dto/topic-too-broad.dto.js";
import { TopicDto } from "../../dto/topic.dto.js";

@Agent({
  name: "topic-researcher-agent",
  description: "Reports on a topic, or says it is too broad",
  prompt: inline("Report on the topic, or say it is too broad to cover at once."),
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
    const { topic, level } = input.topic;
    return Promise.resolve(["history", "state", "outlook"].map((part) => ({ topic: `${topic}: ${part}`, level: level + 1 })));
  }
}
```

```ts file=src/topic/agents/topic-merge/topic-merge.agent.ts
import { Agent, listOf, oneOf, inline } from "@agboss/core";
import { TopicFailedDto } from "../../dto/topic-failed.dto.js";
import { TopicReportDto } from "../../dto/topic-report.dto.js";
import { TopicDto } from "../../dto/topic.dto.js";

@Agent({
  name: "topic-merge-agent",
  description: "Merges the subtopics' reports",
  prompt: inline("Merge the reports into one; note the subtopics that failed."),
  model: "moonshotai/kimi-k2.6",
  input: { topic: TopicDto, parts: listOf(TopicReportDto, TopicFailedDto) },
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
    return Promise.resolve({ topic: input.topic.topic });
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
import { StepError, Workflow, onAction, listOf, oneOf, onStart, toAction, toAgent, toFinish, toWorkflow, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TopicResearchWorkflowStart)
      .toAgent(TopicResearcherAgent)
      .onError(StepError, toAction(MarkTopicFailedAction)) // a failed topic ends softly
      .toOneOf([
        toFinish(TopicReportWorkflowFinish),
        // not offered on the last level: this case recurses
        toAction(SplitTopicAction)
          .forEachItem(
            toWorkflow(() => TopicResearchWorkflow),
            { takeFirst: 3, maxConcurrency: 3 },
          )
          .join()
          .toAgent(TopicMergeAgent)
          .onError(StepError, toAction(MarkTopicFailedAction))
          .toFinish(TopicReportWorkflowFinish),
      ]),

    // two ways in (the researcher's error, the merge's error): its own path
    onAction(MarkTopicFailedAction)
      .toFinish(TopicFailedWorkflowFinish),
  ],
  executionLimits: { maxDepth: 3, maxConcurrency: 4 }, // depth 1 (the root) to 3; at most four executions of the tree work at once
})
export class TopicResearchWorkflow {}
```

- No `maxDepth` → `[graph.recursion-without-depth]`; a branch whose every option recurses →
  `[graph.recursion-without-exit]`; only direct recursion — two workflows launching each other is
  `[graph.mutual-recursion]`; a flow naming its own class (as a thunk) is the recursion itself.
- A launch by code or data past `maxDepth` does not start: the parent's step fails with
  `StepError.Child` caused by `LimitError.Depth` — take it with
  `.onError(LimitError, …)` (actions and finishes only) right after the launch, or
  `.onError(…)` after a per-item join.
- `@Workflow({ executionLimits: { maxConcurrency } })` (default 10, a whole number from 1,
  `[limits.max-concurrent-executions-invalid]`) is how many executions of the tree work at once; a
  child's own larger cap is never reached (`[limits.child-concurrency-above-parent]`, a warning).
- Each level has its own `maxSteps`; the root's budgets pay for the whole tree.

## 8. Undo: compensation on side paths, and the automatic undo

An action that changes the world declares its undo: `@Action({ compensateWith: UndoAction })`, and
optionally its commit point, `committedBy: CommitAction` — once that succeeds nothing undoes it. The
undo is an ordinary `@Action` (code, never a model call) that reads only what the path holds **right
after** its action.

- **Explicit where a path can say it.** A side path (`.onError`) entered after an
  undoable action succeeded must reach its finish through the undo, newest first — `npx agboss check`
  proves it (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`). The record of the
  undo is `CompensationReason.SidePath`.
- **Automatic where no path can say it.** A failed join undoes its finished undoable branches before
  `.onError` runs (`JoinFailed`); an execution that ends without a finish — an uncaught failure
  or limit (`ExecutionFailed`), a cancel or a `FailFast` abort (`ExecutionCancelled`) — undoes its
  open actions, newest first, before it ends. Each automatic undo runs in its own frame (its key is
  the undone step's key + `:compensation`), on a clean-up signal bounded by
  `@Application({ executionLimits: { compensationTimeout } })` (default `seconds(15)`), with no budget check; it survives
  a crash (the next holder of the tree finishes it).
- An undo that fails does not stop the others; then the execution fails with
  `ExecutionError.CompensationFailed` (`failures`, `cause` the original error) — no side path takes it.

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
    await Promise.resolve(`${input.reservation.reservationId}:${this.executionContext.step.idempotencyKey}`);
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
    await Promise.resolve(`${input.payment.paymentId}:${this.executionContext.step.idempotencyKey}`);
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
    await Promise.resolve(input.shipped.trackingNumber);
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
    return Promise.resolve({ reservationId: `reservation-${input.order.orderId}` });
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
    return Promise.resolve({ paymentId: `payment-${input.order.orderId}` });
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
    return Promise.resolve({ trackingNumber: `track-${input.order.orderId}` });
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
    await Promise.resolve(input.order.orderId);
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
import { Workflow, onAction, onStart, toAction, toFinish, Ttl } from "@agboss/core";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrderWorkflowStart)
      .toAction(ReserveStockAction)
      .toAction(ChargeOrderCardAction)
      .toAction(ShipOrderAction)
      .onError(
        CarrierError, // the carrier failed: undo what was done, newest first — proved by agboss check
        toAction(RefundCardAction) // an undo without output
          .onError(
            PaymentProviderError, // the refund itself failed: a person takes over; the stock still goes back
            toAction(NotifyFinanceAction)
              .toAction(ReleaseStockAction),
          )
          .toAction(ReleaseStockAction),
      )
      .toAction(ConfirmOrderAction) // the commit point of the payment
      .toFinish(OrderShippedWorkflowFinish), // a finish commits what is still open (the reservation)

    onAction(ReleaseStockAction) // reached from two places: its own path
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
    await Promise.resolve(input.flight.bookingId);
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
    await Promise.resolve(input.hotel.bookingId);
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
    return Promise.resolve({ bookingId: `flight-${input.request.destination}` });
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
    return Promise.resolve({ bookingId: `hotel-${input.request.destination}` });
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
import { TripBookedDto } from "../../dto/trip-booked.dto.js";

@WorkflowFinish({
  name: "trip-booked-workflow-finish",
  description: "Both bookings",
  output: TripBookedDto,
})
export class TripBookedWorkflowFinish {}
```

```ts file=src/trip/actions/trip-booked.action.ts
import { Action } from "@agboss/core";
import type { ActionHandler, InputOf, OutputOf } from "@agboss/core";
import { FlightBookingDto } from "../dto/flight-booking.dto.js";
import { HotelBookingDto } from "../dto/hotel-booking.dto.js";
import { TripBookedDto } from "../dto/trip-booked.dto.js";

@Action({
  name: "trip-booked-action",
  description: "Both bookings, as one answer",
  input: { flight: FlightBookingDto, hotel: HotelBookingDto },
  output: TripBookedDto,
})
export class TripBookedAction implements ActionHandler<TripBookedAction> {
  execute(input: InputOf<TripBookedAction>): Promise<OutputOf<TripBookedAction>> {
    return Promise.resolve({
      summary: `${input.flight.bookingId} + ${input.hotel.bookingId}`,
    });
  }
}
```

```ts file=src/trip/workflows/trip/trip.workflow.ts
import { Workflow, onStart, toFinish, toAction, Ttl } from "@agboss/core";
import { BookFlightAction } from "../../actions/book-flight.action.js";
import { BookHotelAction } from "../../actions/book-hotel.action.js";
import { TripBookedAction } from "../../actions/trip-booked.action.js";
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TripWorkflowStart)
      .inParallel([toAction(BookFlightAction), toAction(BookHotelAction)])
      .join()
      .onError(
        BookingFailedError, // the hotel failed: the finished flight is cancelled before this path runs
        toFinish(TripNotBookedWorkflowFinish),
      )
      .toAction(TripBookedAction)
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
`StepError.Action`). The most specific handler wins; two for one class on one step are
`[flow.duplicate-error-handler]`. Without a handler the execution fails.

| Class (`code`)                                                                                      | Thrown when                                                        | Side path may use a model?         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `StepError` (`step`)                                                                                | the parent of a step's failures that cost money (rows below)       | yes                                |
| ↳↳ `StepError.Agent` (`step.agent`)                                                                 | an agent's model call or loop failed                               | yes                                |
| ↳↳↳ `StepError.AgentAnswerInvalid` (`step.agent.invalid-answer`)                                    | its answers stayed invalid after the retries                       | yes                                |
| ↳↳↳ `StepError.QualityGate` (`step.agent.quality-gate`)                                             | its judges rejected the answer after `maxRetries`                  | yes                                |
| ↳↳ `StepError.Action` (`step.action`)                                                               | an action threw (the original as `cause`)                          | yes                                |
| ↳↳ `StepError.Router` (`step.router`) ↳ `StepError.RouterDecision` (`step.router.invalid-decision`) | `route()` threw / the model failed; an answer outside the routes   | yes                                |
| ↳↳ `StepError.Guardrail` (`step.guardrail`)                                                         | a guardrail's model did not answer (fails closed)                  | yes                                |
| ↳↳ `StepError.Arbiter` (`step.arbiter`), `StepError.QuorumNotReached` (`step.quorum`)               | an arbiter threw; too few counted answers (`.onError`)             | yes                                |
| ↳↳ `StepError.Child` (`step.child`)                                                                 | a child's uncaught error (its `cause`)                             | yes, unless the cause is a limit   |
| ↳ `GuardrailError.Blocked` (`guardrail.blocked`)                                                    | a guardrail said yes; `refusal` is the text to send instead        | yes                                |
| ↳ `PiiError.Refused` (`pii.refused`)                                                                | a `block()` PII rule matched                                       | yes                                |
| `LimitError` (`limit`)                                                                              | the parent of every limit                                          | **no** — actions and finishes only |
| ↳ `LimitError.Steps` (`limit.steps`)                                                                | the workflow's `maxSteps`                                          | no                                 |
| ↳ `LimitError.Visits` (`limit.visits`)                                                              | a node's `maxVisits`                                               | no                                 |
| ↳ `LimitError.Budget` (`limit.budget`)                                                              | a `@Budget`'s `maxSpend()`                                         | no                                 |
| ↳ `LimitError.Depth` (`limit.depth`)                                                                | a recursive launch past `maxDepth` (inside `StepError.Child`)      | no                                 |
| `ExecutionCancelledError` (`execution.cancelled`)                                                   | `app.cancel` or the caller's `signal` — never taken by a side path | —                                  |
| `ApplicationStoppingError` (`app.stopping`)                                                         | `app.close()` interrupted it — never taken                         | —                                  |
| `ExecutionError.CompensationFailed` (`execution.compensation-failed`)                               | an automatic undo failed — never taken                             | —                                  |

`ToolTimeoutError` (`tool.timeout`) never reaches the flow: a tool call past its `timeout` is read by
its agent's model as the tool's error, like any tool error. All of them are `AGBossError`s.

Your own domain errors are plain `Error` subclasses thrown by services; catch them by class
(`.onError(CarrierError, …)`): the framework's wrapper keeps them as `cause`. A side path that can
catch a limit — `LimitError`, a subclass, or a parent such as `AGBossError` or `Error` —
leads only to actions and finishes (`[graph.limit-handler-uses-model]`): nothing pays past a limit.

## 10. Limits the flow is checked against

- `@Workflow({ executionLimits: { maxSteps } })` — agent, router, action and external-task visits per execution, default (agents + routers + actions + external tasks) × 3.
  `[limits.max-steps-too-low]`: no finish fits in a hand-set `maxSteps`, or the default cannot hold a
  per-item launch's worst case; `[limits.branch-exceeds-max-steps]`: every path through a node is
  longer; `[limits.max-steps-unused]`: a workflow without agents or routers sets it.
- `maxVisits` on an agent or router — every node on a cycle needs one on the cycle
  (`[graph.cycle-without-max-visits]`).
- A path nested more than four branches deep warns `[flow.path-too-deep]`; a node reached with too
  many scopes is `[flow.analysis-too-large]` — move a branch into a child workflow
  (`npx agboss generate workflow <name>-workflow`).

## Pitfalls

- `onStart(A).toAgent(B).toFinish(C)` on one line — one call per line, always.
- `.onError` goes right after the step that throws.
- `.onError` is not offered between a launch and its `.join*()`; after the join it is the join's own handler.
- Continuing a shared node inline in two places (`[flow.shared-node-inline]`) — give it its own path.
- A model router after an agent that already knows the outcome: return `oneOf(…)` and `switch`.
- `executionContext.depth` read by a prompt — no model sees it; a domain level is an input field.
- An undo that is an agent, or an undo that reads what the action never had — the undo is an
  `@Action` over what the path holds right after its action.
