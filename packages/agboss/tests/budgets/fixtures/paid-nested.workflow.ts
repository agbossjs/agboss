import { Workflow, WorkflowFinish, WorkflowStart, Ttl } from "../../../src/index.js";
import { onStart, toAction } from "../../helpers/flow.js";
import {
  BookOrderAction,
  DeclineOrderAction,
  NoteOrderAction,
  RefundOrderAction,
} from "./paid-steps.actions.js";
import { OrderDeclinedError, OrderDto, OrderNoteDto } from "./paid-steps.dto.js";
import { PaidActionWorkflow } from "./paid-steps.workflow.js";

/**
 * #634 — the overspend inside a child: the child books (undoable), pays past the root's budgets,
 * and its next action is held back; the tree fails with the budget's error as it is. And a booking
 * whose paid check declines past the budgets: its side path's undo runs whatever the budgets.
 */

@WorkflowStart({ name: "paid-nested-workflow-start", description: "One order", input: OrderDto })
export class PaidNestedWorkflowStart {}

@WorkflowFinish({ name: "paid-nested-workflow-finish", description: "Noted", output: OrderNoteDto })
export class PaidNestedWorkflowFinish {}

@Workflow({
  name: "paid-nested-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidNestedWorkflowStart)
      .toWorkflow(PaidActionWorkflow)
      .toFinish(PaidNestedWorkflowFinish),
  ],
})
export class PaidNestedWorkflow {}

@WorkflowStart({ name: "paid-refund-workflow-start", description: "One order", input: OrderDto })
export class PaidRefundWorkflowStart {}

@WorkflowFinish({ name: "refunded-workflow-finish", description: "Refunded", output: OrderDto })
export class RefundedWorkflowFinish {}

@WorkflowFinish({ name: "paid-refund-workflow-finish", description: "Noted", output: OrderNoteDto })
export class PaidRefundWorkflowFinish {}

/** Booked, then a paid check past the budgets declines: the side path refunds and finishes. */
@Workflow({
  name: "paid-refund-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidRefundWorkflowStart)
      .toAction(BookOrderAction)
      .toAction(DeclineOrderAction)
      .onError(OrderDeclinedError, toAction(RefundOrderAction).toFinish(RefundedWorkflowFinish))
      .toAction(NoteOrderAction)
      .toFinish(PaidRefundWorkflowFinish),
  ],
})
export class PaidRefundWorkflow {}
