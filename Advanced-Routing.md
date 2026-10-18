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

## Not in the core yet

| Pattern | Issue |
| --- | --- |
| Several branches at once — `.toParallelAgents(…)`, `.toParallelActions(…)`, a per-item launch from `listOf(…)` — with a mandatory `.join()` | #273 |
| Quorum joins (`.joinQuorum(…)`), groups | #279 |
| A code router's list answer for a launch (`route()` returns `Route<R>[]`, `spawn: SpawnPolicy.Always` launched by the framework) and a model router's `OnDemand` decisions | #273 |
| Child workflows (`.toWorkflow(W)`, `caseOf` per child finish) | #263 |

The transition DSL's `nextParallel` / `join`, `batchParallel`, `@QuorumRouter`, `parallel(…)` /
`optional(…)` route targets, `Self` and nested `@Workflow` nodes were removed with it
([ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)); rollback is on [Rollback](Rollback).
