import {
  BudgetExceededError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { onAction, onStart, toAction } from "../../helpers/flow.js";
import {
  AuditOrderAction,
  CheckOrderAction,
  RejectOrderAction,
  TellOrderAction,
} from "./paid-exemptions.actions.js";
import {
  BookOrderAction,
  ChargeOrderAction,
  HoldOrderAction,
  MemoOrderAction,
  NoteOrderAction,
  NotifyOrderAction,
  OverspendOrderAction,
  RefundOrderAction,
} from "./paid-steps.actions.js";
import { OrderDeclinedError, OrderDto, OrderNoteDto } from "./paid-steps.dto.js";

/**
 * #656 — where the budget's two exemptions end: a side path that took the budget's limit and then
 * launches (its own action runs, the branches are held back), the same after a held action (taken
 * over by another instance), the side path of a failed join; and an undo action that is also a
 * step of the main path (held back there, run as the side path's undo).
 */

const startOf = (name: string) =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "One order", input: OrderDto });
const finishOf = (name: string) =>
  WorkflowFinish({ name: `${name}-workflow-finish`, description: "Noted", output: OrderNoteDto });

@finishOf("limit-noted")
export class LimitNotedWorkflowFinish {}
@finishOf("limit-launched")
export class LimitLaunchedWorkflowFinish {}

/** The budget's side path: tells the team, then launches a memo and an audit. */
const launchedAfterLimit = toAction(TellOrderAction)
  .toParallelActions(MemoOrderAction, AuditOrderAction)
  .join()
  .toFinish(LimitLaunchedWorkflowFinish);

@startOf("limit-launch")
export class LimitLaunchWorkflowStart {}

/** Charged past the budgets; the note held back takes the budget's side path, which launches. */
@Workflow({
  name: "limit-launch-workflow",
  version: "1.0.0",
  flow: [
    onStart(LimitLaunchWorkflowStart)
      .toAction(OverspendOrderAction)
      .toAction(NoteOrderAction)
      .onError(BudgetExceededError, launchedAfterLimit)
      .toFinish(LimitNotedWorkflowFinish),
  ],
})
export class LimitLaunchWorkflow {}

@startOf("join-limit")
export class JoinLimitWorkflowStart {}

/** A branch spends the last of the budget, its sibling is held back: the join's side path launches. */
@Workflow({
  name: "join-limit-workflow",
  version: "1.0.0",
  flow: [
    onStart(JoinLimitWorkflowStart)
      .toParallelActions(ChargeOrderAction, NoteOrderAction)
      .join()
      .onError(BudgetExceededError, launchedAfterLimit)
      .toFinish(LimitNotedWorkflowFinish),
  ],
})
export class JoinLimitWorkflow {}

@startOf("held-limit")
export class HeldLimitWorkflowStart {}

/** The budget's side path holds the order (until the test lets it go), then tells the team. */
@Workflow({
  name: "held-limit-workflow",
  version: "1.0.0",
  flow: [
    onStart(HeldLimitWorkflowStart)
      .toAction(OverspendOrderAction)
      .toAction(NoteOrderAction)
      .onError(
        BudgetExceededError,
        toAction(HoldOrderAction).toAction(NotifyOrderAction).toFinish(LimitNotedWorkflowFinish),
      )
      .toFinish(LimitNotedWorkflowFinish),
  ],
})
export class HeldLimitWorkflow {}

@startOf("held-launch")
export class HeldLaunchWorkflowStart {}

/** The budget's side path holds the order, then launches a memo and an audit. */
@Workflow({
  name: "held-launch-workflow",
  version: "1.0.0",
  flow: [
    onStart(HeldLaunchWorkflowStart)
      .toAction(OverspendOrderAction)
      .toAction(NoteOrderAction)
      .onError(
        BudgetExceededError,
        toAction(HoldOrderAction)
          .toParallelActions(MemoOrderAction, AuditOrderAction)
          .join()
          .toFinish(LimitLaunchedWorkflowFinish),
      )
      .toFinish(LimitNotedWorkflowFinish),
  ],
})
export class HeldLaunchWorkflow {}

@startOf("refund-step")
export class RefundStepWorkflowStart {}

@WorkflowFinish({ name: "refund-step-workflow-finish", description: "Done", output: OrderDto })
export class RefundStepWorkflowFinish {}

/**
 * Booked (undone by the refund), then a paid check past the budgets: declined, its side path
 * refunds (an undo); passed, the main path refunds as a step of its own (no undo).
 */
@Workflow({
  name: "refund-step-workflow",
  version: "1.0.0",
  flow: [
    onStart(RefundStepWorkflowStart)
      .toAction(BookOrderAction)
      .toAction(CheckOrderAction)
      .onError(OrderDeclinedError, toAction(RefundOrderAction))
      .toAction(RefundOrderAction),
    onAction(RefundOrderAction).toFinish(RefundStepWorkflowFinish),
  ],
})
export class RefundStepWorkflow {}

@startOf("rebook")
export class RebookWorkflowStart {}

/**
 * Rejected at once (nothing open), its side path books, pays past the budgets and refunds: that
 * refund undoes an entry opened on the side path, not one the side path owes.
 */
@Workflow({
  name: "rebook-workflow",
  version: "1.0.0",
  flow: [
    onStart(RebookWorkflowStart)
      .toAction(RejectOrderAction)
      .onError(
        OrderDeclinedError,
        toAction(BookOrderAction)
          .toAction(OverspendOrderAction)
          .toAction(RefundOrderAction)
          .toFinish(RefundStepWorkflowFinish),
      )
      .toFinish(RefundStepWorkflowFinish),
  ],
})
export class RebookWorkflow {}

@startOf("nested-limit")
export class NestedLimitWorkflowStart {}
@finishOf("nested-limit")
export class NestedLimitWorkflowFinish {}

/** The budget's side path rejects the order; that rejection's own side path tells the team. */
@Workflow({
  name: "nested-limit-workflow",
  version: "1.0.0",
  flow: [
    onStart(NestedLimitWorkflowStart)
      .toAction(OverspendOrderAction)
      .toAction(NoteOrderAction)
      .onError(
        BudgetExceededError,
        toAction(RejectOrderAction)
          .onError(
            OrderDeclinedError,
            toAction(NotifyOrderAction).toFinish(NestedLimitWorkflowFinish),
          )
          .toFinish(RefundStepWorkflowFinish),
      )
      .toFinish(LimitNotedWorkflowFinish),
  ],
})
export class NestedLimitWorkflow {}

@startOf("refund-handled")
export class RefundHandledWorkflowStart {}

@WorkflowFinish({ name: "refund-told-workflow-finish", description: "Told", output: OrderDto })
export class RefundToldWorkflowFinish {}

/** As `refund-step-workflow`, the main path's refund with a side path for the budget's error. */
@Workflow({
  name: "refund-handled-workflow",
  version: "1.0.0",
  flow: [
    onStart(RefundHandledWorkflowStart)
      .toAction(BookOrderAction)
      .toAction(CheckOrderAction)
      .toAction(RefundOrderAction)
      .onError(BudgetExceededError, toAction(TellOrderAction).toFinish(RefundToldWorkflowFinish))
      .toFinish(RefundStepWorkflowFinish),
  ],
})
export class RefundHandledWorkflow {}
