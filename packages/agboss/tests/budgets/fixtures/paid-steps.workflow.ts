import {
  Agent,
  BudgetExceededError,
  DecidedBy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { route, start, toAction, toFinish } from "../../helpers/flow.js";
import {
  BookOrderAction,
  DeclineOrderAction,
  NoteOrderAction,
  NotifyOrderAction,
  OverspendOrderAction,
} from "./paid-steps.actions.js";
import { OrderDeclinedError, OrderDto, OrderNoteDto } from "./paid-steps.dto.js";

/**
 * #634 — after an overspend, the next step of each kind on a path: an action (behind an undoable
 * booking), a code router, an agent, a finish; a side path the overspending step's own error takes,
 * and the one the budget's error takes. The launches, children and recursion are in
 * `paid-launches.workflow.ts`.
 */

const startOf = (name: string) =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "One order", input: OrderDto });
const finishOf = (name: string) =>
  WorkflowFinish({ name: `${name}-workflow-finish`, description: "Noted", output: OrderNoteDto });

@startOf("paid-action")
export class PaidActionWorkflowStart {}
@finishOf("paid-action")
export class PaidActionWorkflowFinish {}

/** Booked (undoable), charged past the budgets, then noted. */
@Workflow({
  name: "paid-action-workflow",
  version: "1.0.0",
  flow: [
    start(PaidActionWorkflowStart)
      .returns(OrderDto)
      .toAction(BookOrderAction)
      .toAction(OverspendOrderAction)
      .returns(OrderDto)
      .toAction(NoteOrderAction)
      .returns(OrderNoteDto)
      .toFinish(PaidActionWorkflowFinish),
  ],
})
export class PaidActionWorkflow {}

@Router({
  name: "paid-order-router",
  description: "Sends the order to its note",
  decidedBy: DecidedBy.Code,
  input: { order: OrderDto },
  routes: [{ target: NoteOrderAction }],
})
export class PaidOrderRouter {
  route(): unknown {
    return NoteOrderAction;
  }
}

@startOf("paid-router")
export class PaidRouterWorkflowStart {}
@finishOf("paid-router")
export class PaidRouterWorkflowFinish {}

@Workflow({
  name: "paid-router-workflow",
  version: "1.0.0",
  flow: [
    start(PaidRouterWorkflowStart)
      .returns(OrderDto)
      .toAction(OverspendOrderAction)
      .returns(OrderDto)
      .toRouter(PaidOrderRouter)
      .chooseOne(route(NoteOrderAction)
        .returns(OrderNoteDto)
        .toFinish(PaidRouterWorkflowFinish)),
  ],
})
export class PaidRouterWorkflow {}

@Agent({
  name: "paid-review-agent",
  description: "Reviews the order",
  prompt: "Review the order.",
  model: "test/reviewer",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  input: { order: OrderDto },
  output: OrderNoteDto,
})
export class PaidReviewAgent {}

@startOf("paid-agent")
export class PaidAgentWorkflowStart {}
@finishOf("paid-agent")
export class PaidAgentWorkflowFinish {}

@Workflow({
  name: "paid-agent-workflow",
  version: "1.0.0",
  flow: [
    start(PaidAgentWorkflowStart)
      .returns(OrderDto)
      .toAction(OverspendOrderAction)
      .returns(OrderDto)
      .toAgent(PaidReviewAgent)
      .returns(OrderNoteDto)
      .toFinish(PaidAgentWorkflowFinish),
  ],
})
export class PaidAgentWorkflow {}

@startOf("paid-finish")
export class PaidFinishWorkflowStart {}

@WorkflowFinish({ name: "paid-order-workflow-finish", description: "Paid", output: OrderDto })
export class PaidOrderWorkflowFinish {}

/** Charged past the budgets, then finished: a finish spends nothing, so nothing holds it back. */
@Workflow({
  name: "paid-finish-workflow",
  version: "1.0.0",
  flow: [
    start(PaidFinishWorkflowStart)
      .returns(OrderDto)
      .toAction(OverspendOrderAction)
      .returns(OrderDto)
      .toFinish(PaidOrderWorkflowFinish),
  ],
})
export class PaidFinishWorkflow {}

@startOf("paid-declined")
export class PaidDeclinedWorkflowStart {}
@finishOf("paid-declined")
export class PaidDeclinedWorkflowFinish {}
@finishOf("declined-noted")
export class DeclinedNotedWorkflowFinish {}

/** A paid check past the budgets that declines: its side path's action is held back too. */
@Workflow({
  name: "paid-declined-workflow",
  version: "1.0.0",
  flow: [
    start(PaidDeclinedWorkflowStart)
      .returns(OrderDto)
      .toAction(DeclineOrderAction)
      .onError(
        OrderDeclinedError,
        toAction(NotifyOrderAction)
          .returns(OrderNoteDto)
          .toFinish(DeclinedNotedWorkflowFinish),
      )
      .returns(OrderDto)
      .toAction(NoteOrderAction)
      .returns(OrderNoteDto)
      .toFinish(PaidDeclinedWorkflowFinish),
  ],
})
export class PaidDeclinedWorkflow {}

@startOf("paid-limit")
export class PaidLimitWorkflowStart {}
@finishOf("paid-limit")
export class PaidLimitWorkflowFinish {}
@finishOf("over-budget")
export class OverBudgetWorkflowFinish {}

/** The note held back by the budget: the budget's own side path tells the team, and finishes. */
@Workflow({
  name: "paid-limit-workflow",
  version: "1.0.0",
  flow: [
    start(PaidLimitWorkflowStart)
      .returns(OrderDto)
      .toAction(OverspendOrderAction)
      .returns(OrderDto)
      .toAction(NoteOrderAction)
      .onError(
        BudgetExceededError,
        toAction(NotifyOrderAction)
          .returns(OrderNoteDto)
          .toFinish(OverBudgetWorkflowFinish),
      )
      .returns(OrderNoteDto)
      .toFinish(PaidLimitWorkflowFinish),
  ],
})
export class PaidLimitWorkflow {}
