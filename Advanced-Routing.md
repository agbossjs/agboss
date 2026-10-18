# Routing patterns

Patterns of routers on the paths (#272, #280): one choice, routers in a chain, a router in a loop,
a branch by the result of the chosen step, a router's failure, a rule decided by code. The grammar
is on [Workflow](Workflow), the router component on [Routers](Routers). Everything here is in the
root entry `agboss` (`start`, `router`, `route`, `caseOf`, `toAction`, `toFinish`, …); parallel
launches, quorums and child workflows build on these paths later (see the end).

The nodes used below (ordinary components):

<!--
```ts file=nodes.ts
import { Action, Agent, DecidedBy, Router, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf } from "agboss";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto, oneOf } from "agboss/dto";
const model = "moonshotai/kimi-k2.6";
export class TicketDto {
  @Text({ prompt: "the ticket" })
  summary!: string;
}
export class AnswerDto {
  @Text({ prompt: "the answer" })
  text!: string;
}
export class NeedsHumanDto {
  @Text({ prompt: "why a person must answer" })
  reason!: string;
}
@WorkflowStart({ name: "ticket-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class TicketWorkflowStart {}
@WorkflowFinish({ name: "answer-workflow-finish", description: "The answer", output: AnswerDto })
export class AnswerWorkflowFinish {}
@WorkflowFinish({ name: "reply-workflow-finish", description: "A text reply", output: WorkflowFinishTextDto })
export class ReplyWorkflowFinish {}
@WorkflowFinish({ name: "escalated-workflow-finish", description: "Handed to a person", output: NeedsHumanDto })
export class EscalatedWorkflowFinish {}
@WorkflowFinish({ name: "unrouted-workflow-finish", description: "Nobody could take it", output: WorkflowStartTextDto })
export class UnroutedWorkflowFinish {}
@Agent({ name: "billing-agent", description: "Billing questions", prompt: "Answer billing questions.", model, input: { message: WorkflowStartTextDto }, output: oneOf(AnswerDto, NeedsHumanDto) })
export class BillingAgent {}
@Agent({ name: "refund-agent", description: "Refunds", prompt: "Handle the refund.", model, input: { message: WorkflowStartTextDto }, output: AnswerDto })
export class RefundAgent {}
@Agent({ name: "chat-agent", description: "Small talk", prompt: "Chat.", model })
export class ChatAgent {}
@Agent({ name: "triage-agent", description: "Summarises the message as a ticket", prompt: "Summarise the message.", model, input: { message: WorkflowStartTextDto }, output: TicketDto, maxVisits: 2 })
export class TriageAgent {}
@Action({ name: "open-ticket-action", description: "Opens a ticket", input: { ticket: TicketDto }, output: AnswerDto })
export class OpenTicketAction implements ActionHandler<OpenTicketAction> {
  execute(input: InputOf<OpenTicketAction>): Promise<AnswerDto> {
    return Promise.resolve({ text: `ticket opened: ${input.ticket.value.summary}` });
  }
}
@Router({
  name: "money-router",
  description: "Billing or refund",
  decidedBy: DecidedBy.Model,
  prompt: "Is it about a bill or a refund?",
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "A question about a bill", target: BillingAgent },
    { prompt: "A refund", target: RefundAgent },
  ],
})
export class MoneyRouter {}
@Router({
  name: "front-router",
  description: "Money matters, small talk or a ticket",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who handles the customer's message.",
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "Money: a bill or a refund", target: MoneyRouter },
    { prompt: "Small talk", target: ChatAgent },
    { prompt: "Anything else: open a ticket", target: TriageAgent },
    { prompt: "Stop without an answer: the message is empty or spam", target: UnroutedWorkflowFinish },
  ],
})
export class FrontRouter {}
@Router({
  name: "ticket-router",
  description: "Opens the ticket or asks again",
  decidedBy: DecidedBy.Model,
  prompt: "Is the ticket clear enough to open?",
  input: { ticket: TicketDto },
  maxVisits: 2,
  routes: [
    { prompt: "The ticket is clear", target: OpenTicketAction },
    { prompt: "The ticket is unclear: summarise again", target: TriageAgent },
  ],
})
export class TicketRouter {}
```
-->

## 1. One choice, routers in a chain

A router's choice lists its routes, each continued to its end. A route may lead to another router —
here the front router hands money matters to a second one:

<!-- snippet-context
import { Workflow, RouterFailedError, agent, caseOf, route, start, toFinish } from "agboss";
import { WorkflowStartTextDto, oneOf } from "agboss/dto";
import { AnswerDto, AnswerWorkflowFinish, BillingAgent, ChatAgent, EscalatedWorkflowFinish, FrontRouter, MoneyRouter, NeedsHumanDto, OpenTicketAction, RefundAgent, ReplyWorkflowFinish, TicketDto, TicketRouter, TicketWorkflowStart, TriageAgent, UnroutedWorkflowFinish } from "./nodes.js";
-->

```ts
@Workflow({
  name: "front-desk-workflow",
  version: "1.0.0",
  defaults: { router: { model: "typesafe/jev-1.13" } }, // the routers' model
  flow: [
    start(TicketWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(FrontRouter)
      // 4. the router's own failure: a failed call or a not-allowed answer goes to a finish
      .onError(RouterFailedError, toFinish(UnroutedWorkflowFinish))
      .chooseOne(
        // 1. a route to another router: its choice is continued right there
        route(MoneyRouter)
          .chooseOne(
            // 2. a branch by the result of the chosen agent
            route(BillingAgent)
              .returns(oneOf(AnswerDto, NeedsHumanDto))
              .switch(
                caseOf(AnswerDto)
                  .toFinish(AnswerWorkflowFinish),
                caseOf(NeedsHumanDto)
                  .toFinish(EscalatedWorkflowFinish),
              ),
            route(RefundAgent)
              .returns(AnswerDto)
              .toFinish(AnswerWorkflowFinish),
          ),
        route(ChatAgent)
          .toFinish(ReplyWorkflowFinish), // a text agent answers text
        // 3. a router in a loop: the triage agent is reached from two places → its own path
        route(TriageAgent),
        route(UnroutedWorkflowFinish),
      ),

    agent(TriageAgent)
      .returns(TicketDto)
      .toRouter(TicketRouter)
      .chooseOne(
        route(OpenTicketAction)
          .returns(AnswerDto)
          .toFinish(AnswerWorkflowFinish),
        route(TriageAgent), // back: maxVisits bounds the loop
      ),
  ],
})
export class FrontDeskWorkflow {}
```

## 2. A branch by the chosen step's result

An agent with a `oneOf` output continues with `.returns(oneOf(…)).switch(caseOf(…)…)` — one case per variant, each
its own path; a missing or unknown case fails assembly (`[flow.switch-not-exhaustive]`,
`[flow.switch-unknown-case]`). Asking or refusing is just a case that leads to a finish.

## 3. A router in a loop

A node reached from two or more places is continued in its own path (`agent(TriageAgent)…`,
`router(R)…`), and every path into it ends at it — the loop is visible. Every cycle needs
`maxVisits` on one of its nodes (`[graph.cycle-without-max-visits]`); a visit past it fails before
the model call with `VisitsLimitExceededError`, which `.onError` right after that step can take.

## 4. When the router fails

`.onError(…)` right after `.toRouter(R)` takes the router's failure (#280 S19); a side path with
`toAction(…)` can log it before its finish. Without a handler the run fails.

- `.onError(RouterFailedError, …)` — any failure of the step: its model call or its `route()`
  failed (`step.router`), or its answer is not allowed.
- `.onError(RouterDecisionError, …)` — only a not-allowed answer (`step.router.invalid-decision`:
  a target outside its routes, an unknown or unreadable answer); never retried.
- `.onError(DomainError, …)` — the error a code router's `route()` (or the service it calls)
  threw, caught through `RouterFailedError`'s cause.

## 5. A rule decided by code

A model reads the text into a typed DTO; a code router decides by the type — no second model call,
no matching text ([Routers → Routers decided by code](Routers#routers-decided-by-code)):

<!--
```ts file=rule.parts.ts
import { Action, Agent, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { Flag, WorkflowStartTextDto } from "agboss/dto";
import { AnswerDto } from "./nodes.js";
export class PriorityDto {
  @Flag({ prompt: "whether the customer cannot work until it is fixed" })
  isUrgent!: boolean;
}
@Agent({ name: "priority-agent", description: "Reads how urgent the message is", prompt: "How urgent is it?", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: PriorityDto })
export class PriorityAgent {}
@Action({ name: "page-on-call-action", description: "Pages the on-call engineer", input: { priority: PriorityDto }, output: AnswerDto })
export class PageOnCallAction implements ActionHandler<PageOnCallAction> {
  execute(): Promise<OutputOf<PageOnCallAction>> {
    return Promise.resolve({ text: "the on-call engineer is paged" });
  }
}
@Action({ name: "queue-ticket-action", description: "Queues the ticket", input: { priority: PriorityDto }, output: AnswerDto })
export class QueueTicketAction implements ActionHandler<QueueTicketAction> {
  execute(input: InputOf<QueueTicketAction>): Promise<OutputOf<QueueTicketAction>> {
    return Promise.resolve({ text: `queued (urgent: ${String(input.priority.value.isUrgent)})` });
  }
}
```
-->

<!-- snippet-context
import { DecidedBy, Router, Workflow, route, start, type InputOf, type Route, type RouterHandler } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { AnswerDto, AnswerWorkflowFinish, TicketWorkflowStart } from "./nodes.js";
import { PageOnCallAction, PriorityAgent, PriorityDto, QueueTicketAction } from "./rule.parts.js";
-->

```ts
@Router({
  name: "priority-router",
  description: "Pages the on-call engineer for urgent messages, queues the rest",
  decidedBy: DecidedBy.Code,
  input: { priority: PriorityDto },
  routes: [{ target: PageOnCallAction }, { target: QueueTicketAction }],
})
export class PriorityRouter implements RouterHandler<PriorityRouter> {
  route(input: InputOf<PriorityRouter>): Route<PriorityRouter> {
    return input.priority.value.isUrgent ? PageOnCallAction : QueueTicketAction;
  }
}

@Workflow({
  name: "priority-workflow",
  version: "1.0.0",
  flow: [
    start(TicketWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PriorityAgent)
      .returns(PriorityDto)
      .toRouter(PriorityRouter) // a code router: the flow is the same as for a model router
      .chooseOne(
        route(PageOnCallAction)
          .returns(AnswerDto)
          .toFinish(AnswerWorkflowFinish),
        route(QueueTicketAction)
          .returns(AnswerDto)
          .toFinish(AnswerWorkflowFinish),
      ),
  ],
})
export class PriorityWorkflow {}
```

A code router may also sit inside a model router's `route(…)` — `route(PriorityRouter).chooseOne(…)`
— or the other way round; routers chain in any mix with no step between them.

## 6. A router decides who is launched

After `.toRouter(R)` a parallel launch (#273) lists the router's routes (`[router.routes-mismatch]`)
and its routes carry the launch's policies: `spawn` — `SpawnPolicy.Always` (the framework launches
it; no model sees it, so it has no prompt) or `SpawnPolicy.OnDemand` (the router decides; a model
router reads its route `prompt`) — and `failure` — `FailurePolicy.FailFast` (default) or
`FailurePolicy.Skip` (a failed agent drops out of the join). A value of an `OnDemand` or `Skip`
branch is `optional(XDto)` in `.join().returns(…)` and in every consumer's `input`.

<!-- snippet-context
import { Agent, DecidedBy, FailurePolicy, Router, SpawnPolicy, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { Text, WorkflowStartTextDto, optional } from "agboss/dto";

export class OrderStatusDto {
  @Text({ prompt: "where the order is" })
  status!: string;
}
export class RefundPolicyDto {
  @Text({ prompt: "the refund policy" })
  policy!: string;
}
export class LoyaltyOfferDto {
  @Text({ prompt: "an offer" })
  offer!: string;
}
export class CustomerReplyDto {
  @Text({ prompt: "the reply" })
  text!: string;
}
@WorkflowStart({ name: "support-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class SupportWorkflowStart {}
@Agent({ name: "order-agent", description: "Looks the order up", prompt: "Look it up.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: OrderStatusDto })
export class OrderAgent {}
@Agent({ name: "refund-policy-agent", description: "Quotes the policy", prompt: "Quote it.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: RefundPolicyDto })
export class RefundPolicyAgent {}
@Agent({ name: "loyalty-agent", description: "Finds an offer", prompt: "Find one.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: LoyaltyOfferDto })
export class LoyaltyAgent {}
@Agent({ name: "answer-agent", description: "Replies", prompt: "Reply.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto, order: OrderStatusDto, refund: optional(RefundPolicyDto), loyalty: optional(LoyaltyOfferDto) }, output: CustomerReplyDto })
export class AnswerAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The reply", output: CustomerReplyDto })
export class SupportWorkflowFinish {}
// @snippet
@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [
    start(SupportWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(SupportRouter)
      .toParallelAgents(OrderAgent, RefundPolicyAgent, LoyaltyAgent)
      .join()
      .returns(OrderStatusDto)
      .returns(optional(RefundPolicyDto)) // OnDemand — may not launch
      .returns(optional(LoyaltyOfferDto)) // Skip — may drop out
      .toAgent(AnswerAgent)
      .returns(CustomerReplyDto)
      .toFinish(SupportWorkflowFinish),
  ],
})
export class SupportWorkflow {}
-->

```ts
@Router({
  name: "support-router",
  description: "Picks everyone needed for the customer's message",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick everyone needed for the customer's message.",
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: OrderAgent, spawn: SpawnPolicy.Always },
    { target: RefundPolicyAgent, spawn: SpawnPolicy.OnDemand, prompt: "The message is about returns" },
    { target: LoyaltyAgent, spawn: SpawnPolicy.Always, failure: FailurePolicy.Skip },
  ],
})
export class SupportRouter {}
```

| Rule | |
| --- | --- |
| A model router states `spawn` | before a launch every route of a model router says `spawn` — `[router.spawn-required]`; an `Always` route has no prompt — `[router.prompt-on-always]` (a compile error too); an `OnDemand` one has one — `[router.no-prompt]` |
| It decides something | at least one `OnDemand` route — `[router.all-routes-always]` |
| A code router | its route is `OnDemand` unless it says `spawn: SpawnPolicy.Always`; before a launch its `route(input)` returns the `OnDemand` agents to launch — `RouterAnswerOf<Self>` is a list (`readonly [Route<Self>, ...Route<Self>[]]` when no route is `Always`, so `[]` does not compile) |
| Agents only | a router launches agents: `.toParallelActions(…)` after a router does not compile |
| Policies live in the router | with `.chooseOne(…)` they are `[router.policy-with-choose-one]`; a launch from an agent, a start or an action has none (all `Always` + `FailFast`) |

At run time (#273 PR 2, S21, S23):

| | |
| --- | --- |
| A model router decides in one call | one independent yes/no question per `OnDemand` route, its text the route's `prompt`, keyed by the target's `name` in the order of `routes`; the router's own `prompt` leads the state it decides on. A decision model (Jev) answers one `decide` with a `Decision.noul` per route; a chat model one answer tool (`answer-launch`) with a boolean field per route. A route is launched when its answer is yes — P(yes) above 0.5, no threshold setting; every probability goes into the trace ("launch decision"). `Always` routes are never shown to the model |
| All no | with an `Always` route only the `Always` targets run; with none, nothing would run → `RouterDecisionError` (`step.router.invalid-decision`), as for a code router's empty list |
| A code router | `route(input)` returns the `OnDemand` targets to launch, as a list; one class, a target outside its `OnDemand` routes (an `Always` one included) or `[]` without an `Always` route → `RouterDecisionError` |
| `FailurePolicy.Skip` | drops only the branch's own step failure — `error instanceof StepFailedError` (`AgentFailedError`, `AgentAnswerInvalidError`, `QualityGateError`, …): the branch ends `BranchStatus.Skipped`, its error stays in `result.launches`, its siblings go on and its value is absent (`optional`). A limit (`maxSteps`, `maxVisits`, a budget) in a `Skip` branch fails the launch like `FailFast`; a cancel of the execution stops it whole (`WorkflowCancelledError`). `.onJoinError(StepFailedError, …)` takes exactly what `Skip` drops: `StepFailedError` has its own code, `step.failed` |
| In a test | script the router's decision like a decision model's, by target name: `mockLlm(SupportRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9 }))` — also for a chat-model router (P(yes) above 0.5 is `true`) ([Testing](Testing)) |

## Not in the core yet

| Pattern | Issue |
| --- | --- |
| Quorum joins (`.joinQuorum(…)`), groups | #279 |
| Child workflows (`.toWorkflow(W)`, `caseOf` per child finish) | #263 |

The transition DSL's `nextParallel` / `join`, `batchParallel`, `@QuorumRouter`, `parallel(…)` /
`optional(…)` route targets, `Self` and nested `@Workflow` nodes were removed with it
([ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)); rollback is on [Rollback](Rollback).
