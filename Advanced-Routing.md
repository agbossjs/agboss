# Routing patterns

Patterns of routers on the paths (#272, #280): one choice, routers in a chain, a router in a loop,
a branch by the result of the chosen step, a router's failure, a rule decided by code. The grammar
is on [Workflow](Workflow), the router component on [Routers](Routers). Everything here is in the
root entry `agboss` (`onStart`, `onRouter`, `toAgent`, `toAction`, `toFinish`, …); parallel
launches, quorums and child workflows build on these paths ([Parallel](Parallel), [Workflow as a step](Workflow-as-a-step)).

The nodes used below (ordinary components):

<!--
```ts file=nodes.ts
import { oneOf } from "@agboss/core";
import { inline, Action, Agent, DecidedBy, Router, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf } from "@agboss/core";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
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
@Agent({ name: "billing-agent", description: "Billing questions", prompt: inline("Answer billing questions."), model, input: { message: WorkflowStartTextDto }, output: oneOf(AnswerDto, NeedsHumanDto) })
export class BillingAgent {}
@Agent({ name: "refund-agent", description: "Refunds", prompt: inline("Handle the refund."), model, input: { message: WorkflowStartTextDto }, output: AnswerDto })
export class RefundAgent {}
@Agent({ name: "chat-agent", description: "Small talk", prompt: inline("Chat."), model })
export class ChatAgent {}
@Agent({ name: "triage-agent", description: "Summarises the message as a ticket", prompt: inline("Summarise the message."), model, input: { message: WorkflowStartTextDto }, output: TicketDto, executionLimits: { maxVisits: 2 } })
export class TriageAgent {}
@Action({ name: "open-ticket-action", description: "Opens a ticket", input: { ticket: TicketDto }, output: AnswerDto })
export class OpenTicketAction implements ActionHandler<OpenTicketAction> {
  execute(input: InputOf<OpenTicketAction>): Promise<AnswerDto> {
    return Promise.resolve({ text: `ticket opened: ${input.ticket.summary}` });
  }
}
@Router({
  name: "money-router",
  description: "Billing or refund",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is it about a bill or a refund?"),
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
  prompt: inline("Pick who handles the customer's message."),
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
  prompt: inline("Is the ticket clear enough to open?"),
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

A router lists its routes as `.onRoute(…)` paths, each continued to its end. A route may lead to another router —
here the front router hands money matters to a second one:

<!-- snippet-context
import { toAgent, toRouter, toAction } from "@agboss/core";
import { Ttl } from "@agboss/core";
import { Workflow, StepError, onAgent, onStart, toFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { AnswerDto, AnswerWorkflowFinish, BillingAgent, ChatAgent, EscalatedWorkflowFinish, FrontRouter, MoneyRouter, NeedsHumanDto, OpenTicketAction, RefundAgent, ReplyWorkflowFinish, TicketDto, TicketRouter, TicketWorkflowStart, TriageAgent, UnroutedWorkflowFinish } from "./nodes.js";
-->

```ts
@Workflow({
  name: "front-desk-workflow",
  version: "1.0.0", historyTtl: Ttl.Forever,
  defaults: { router: { model: "typesafe/jev-1.13" } }, // the routers' model
  flow: [
    onStart(TicketWorkflowStart)
      .toRouter(FrontRouter)
      // 4. the router's own failure: a failed call or a not-allowed answer goes to a finish
      .onError(StepError.Router, toFinish(UnroutedWorkflowFinish))
      // 1. a route to another router: its choice is continued right there
      .onRoute(
        toRouter(MoneyRouter)
          // 2. a branch by the result of the chosen agent
          .onRoute(
            toAgent(BillingAgent)
              .toOneOf([
                toFinish(AnswerWorkflowFinish),
                toFinish(EscalatedWorkflowFinish),
              ]),
          )
          .onRoute(
            toAgent(RefundAgent)
              .toFinish(AnswerWorkflowFinish),
          ),
      )
      .onRoute(
        toAgent(ChatAgent) // a text agent answers text
          .toFinish(ReplyWorkflowFinish),
      )
      // 3. a router in a loop: the triage agent is reached from two places → its own path
      .onRoute(toAgent(TriageAgent))
      .onRoute(toFinish(UnroutedWorkflowFinish)),

    onAgent(TriageAgent)
      .toRouter(TicketRouter)
      .onRoute(
        toAction(OpenTicketAction)
          .toFinish(AnswerWorkflowFinish),
      )
      .onRoute(toAgent(TriageAgent)), // back: maxVisits bounds the loop
  ],
})
export class FrontDeskWorkflow {}
```

## 2. A branch by the chosen step's result

An agent with a `oneOf` output continues with `.toOneOf([…])` — one branch per variant, each
its own path, told apart by what its first node reads (a finish by its output class); a missing or
ambiguous branch fails assembly (`[flow.one-of-not-exhaustive]`, `[flow.one-of-ambiguous]`). Asking or
refusing is just a branch that leads to a finish.

## 3. A router in a loop

A node reached from two or more places is continued in its own path (`onAgent(TriageAgent)…`,
`onRouter(R)…`), and every path into it ends at it — the loop is visible. Every cycle needs
`maxVisits` on one of its nodes (`[graph.cycle-without-max-visits]`); a visit past it fails before
the model call with `LimitError.Visits`, which `.onError` right after that step can take.

## 4. When the router fails

`.onError(…)` right after `.toRouter(R)` takes the router's failure (#280 S19); a side path with
`toAction(…)` can log it before its finish. Without a handler the run fails.

- `.onError(StepError.Router, …)` — any failure of the step: its model call or its `route()`
  failed (`step.router`), or its answer is not allowed.
- `.onError(StepError.RouterDecision, …)` — only a not-allowed answer (`step.router.invalid-decision`:
  a target outside its routes, an unknown or unreadable answer); never retried.
- `.onError(DomainError, …)` — the error a code router's `route()` (or the service it calls)
  threw, caught through `StepError.Router`'s cause.

## 5. A rule decided by code

A model reads the text into a typed DTO; a code router decides by the type — no second model call,
no matching text ([Routers → Routers decided by code](Routers#routers-decided-by-code)):

<!--
```ts file=rule.parts.ts
import { inline, Action, Agent, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { Bool, WorkflowStartTextDto } from "@agboss/core/dto";
import { AnswerDto } from "./nodes.js";
export class PriorityDto {
  @Bool({ prompt: "whether the customer cannot work until it is fixed" })
  isUrgent!: boolean;
}
@Agent({ name: "priority-agent", description: "Reads how urgent the message is", prompt: inline("How urgent is it?"), model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: PriorityDto })
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
    return Promise.resolve({ text: `queued (urgent: ${String(input.priority.isUrgent)})` });
  }
}
```
-->

<!-- snippet-context
import { toAction } from "@agboss/core";
import { Ttl } from "@agboss/core";
import { DecidedBy, Router, Workflow, onStart, type InputOf, type Route, type RouterHandler } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { AnswerDto, AnswerWorkflowFinish, TicketWorkflowStart } from "./nodes.js";
import { PageOnCallAction, PriorityAgent, PriorityDto, QueueTicketAction } from "./rule.parts.js";
-->

```ts
@Router({
  name: "priority-router",
  description: "Pages the on-call engineer for urgent messages, queues the rest",
  decidedBy: DecidedBy.Code,
  input: { priority: PriorityDto },
  routes: [PageOnCallAction, QueueTicketAction],
})
export class PriorityRouter implements RouterHandler<PriorityRouter> {
  route(input: InputOf<PriorityRouter>): Route<PriorityRouter> {
    return input.priority.isUrgent ? PageOnCallAction : QueueTicketAction;
  }
}

@Workflow({
  name: "priority-workflow",
  version: "1.0.0", historyTtl: Ttl.Forever,
  flow: [
    onStart(TicketWorkflowStart)
      .toAgent(PriorityAgent)
      .toRouter(PriorityRouter) // a code router: the flow is the same as for a model router
      .onRoute(
        toAction(PageOnCallAction)
          .toFinish(AnswerWorkflowFinish),
      )
      .onRoute(
        toAction(QueueTicketAction)
          .toFinish(AnswerWorkflowFinish),
      ),
  ],
})
export class PriorityWorkflow {}
```

A code router may also sit inside a model router's `.onRoute(…)` — `.onRoute(toRouter(PriorityRouter).onRoute(…)…)`
— or the other way round; routers chain in any mix with no step between them.

## 6. A router decides who is launched

A router in a parallel launch (#273, #1279) is a **branch**: `toRouter(R).chooseMany([toAgent(A), …])`
lists the router's routes (`[router.routes-mismatch]`) and the router decides which of them are
launched — the others never run. A route a router may leave out gives an `optional(XDto)` value to the
join, so does a branch a failure may drop: `.onError(StepError, skip())` on it. The other
branches of the launch run as listed.

<!-- snippet-context
import { Ttl } from "@agboss/core";
import { toAgent, toRouter, skip, optional, StepError } from "@agboss/core";
import { inline, Agent, DecidedBy, Router, Workflow, WorkflowFinish, WorkflowStart, onStart } from "@agboss/core";
import { Text, WorkflowStartTextDto } from "@agboss/core/dto";

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
@Agent({ name: "order-agent", description: "Looks the order up", prompt: inline("Look it up."), model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: OrderStatusDto })
export class OrderAgent {}
@Agent({ name: "refund-policy-agent", description: "Quotes the policy", prompt: inline("Quote it."), model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: RefundPolicyDto })
export class RefundPolicyAgent {}
@Agent({ name: "loyalty-agent", description: "Finds an offer", prompt: inline("Find one."), model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: LoyaltyOfferDto })
export class LoyaltyAgent {}
@Agent({ name: "answer-agent", description: "Replies", prompt: inline("Reply."), model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto, order: OrderStatusDto, refund: optional(RefundPolicyDto), loyalty: optional(LoyaltyOfferDto) }, output: CustomerReplyDto })
export class AnswerAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The reply", output: CustomerReplyDto })
export class SupportWorkflowFinish {}
// @snippet
@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SupportWorkflowStart)
      .inParallel([
        toAgent(OrderAgent), // always runs
        toAgent(LoyaltyAgent)
          .onError(StepError, skip()), // a failure drops it: optional(LoyaltyOfferDto)
        toRouter(SupportRouter)
          .chooseMany([toAgent(RefundPolicyAgent)]), // the router decides: optional(RefundPolicyDto)
      ])
      .join()
      .toAgent(AnswerAgent)
      .toFinish(SupportWorkflowFinish),
  ],
})
export class SupportWorkflow {}
-->

```ts
@Router({
  name: "support-router",
  description: "Decides whether the refund policy is needed",
  decidedBy: DecidedBy.Model,
  model: "moonshotai/kimi-k2.6",
  prompt: inline("Pick everyone needed for the customer's message."),
  input: { message: WorkflowStartTextDto },
  routes: [{ prompt: "The message is about returns", target: RefundPolicyAgent }],
})
export class SupportRouter {}
```

| Rule | |
| --- | --- |
| A model router's route has a prompt | every route of a model router says what the choice means — `[router.no-prompt]` otherwise (a compile error too); the text is the route's yes/no question |
| A code router | its `route(input)` returns the agents to launch as a list, `[]` included |
| Routes match | the `chooseMany([…])` list is exactly the router's routes (`[router.routes-mismatch]`) |
| Agents only | a router launches agents; its branches are `toAgent(…)` |
| No policies | there is no per-route `spawn` or `failure`: what always runs is a branch beside the router, what may fail softly is `.onError(StepError, skip())` on its branch |

At run time (#273 PR 2, S21, S23):

| | |
| --- | --- |
| A model router decides in one call | one independent yes/no question per route, its text the route's `prompt`, keyed by the target's `name` in the order of `routes`; the router's own `prompt` leads the state; a decision model asks one `Decision.boolean` per route, a chat model one answer tool with a boolean per route |
| All no | none of its routes launched: `[]` is an answer (S23) — the join gives the router's branches `optional` values, absent |
| A code router | `route(input)` returns the targets to launch, as a list; a target outside its routes → `StepError.RouterDecision` |
| `skip()` | `.onError(E, skip())` drops only the branch's own step failure — `error instanceof StepError` (`StepError.Agent`, `StepError.AgentAnswerInvalid`, `StepError.QualityGate`, …): the branch ends `BranchStatus.Skipped`, its siblings go on; a limit error (`LimitError`), a cancel or a pause is never dropped |
| In a test | script the router's decision by target name: `mockModel(SupportRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9 }))` — also for a chat-model router (P(yes) above 0.5 is `true`) |

## Not in the core yet

Quorum joins (`.joinQuorum(…)`), groups and arbiters run ([Parallel](Parallel)); so do child
workflows (`.toWorkflow(W)`, `.toOneOf([…])` per child finish — [Workflow as a step](Workflow-as-a-step)).

The transition DSL's `nextParallel` / `join`, `batchParallel`, `@QuorumRouter`, `parallel(…)` /
`optional(…)` route targets, `Self` and nested `@Workflow` nodes were removed with it
([ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)); rollback is on [Rollback](Rollback).
