import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { usd } from "../../../src/units/index.js";
import { CheckOrderAction, ExemptionsLog } from "./paid-exemptions.actions.js";
import {
  BookOrderAction,
  MemoOrderAction,
  PaidStepsLog,
  RefundOrderAction,
} from "./paid-steps.actions.js";
import { OrderDto, paidSteps } from "./paid-steps.dto.js";

/**
 * #683 — a booking's undo action launched as a branch, past the budget: the launch's branches are
 * steps (#656), so the refund's branch is held back and the join fails; nothing can take that
 * failure while the booking is open (`agboss check`: a launched undo never undoes, and its class
 * is a branch only), so the execution fails and its automatic undo refunds the booking once — in a
 * parallel launch, a per-item launch, a child on this instance and a child on any instance.
 */

const startOf = (name: string) =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "One order", input: OrderDto });
const finishOf = (name: string) =>
  WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: OrderDto });

@startOf("held-branch")
export class HeldBranchWorkflowStart {}
@finishOf("held-branch")
export class HeldBranchWorkflowFinish {}

/** Booked, charged past the budgets, then the refund launched beside a memo. */
@Workflow({
  name: "held-branch-workflow",
  version: "1.0.0",
  flow: [
    start(HeldBranchWorkflowStart)
      .returns(OrderDto)
      .toAction(BookOrderAction)
      .toAction(CheckOrderAction)
      .returns(OrderDto)
      .toParallelActions(RefundOrderAction, MemoOrderAction)
      .join()
      .toFinish(HeldBranchWorkflowFinish),
  ],
})
export class HeldBranchWorkflow {}

/** The order split into its parts, past the budgets. */
@Action({
  name: "split-order-action",
  description: "Splits the order into its parts through a paid service",
  input: { order: OrderDto },
  output: listOf(OrderDto),
  deps: [SpendRecorder],
})
export class SplitOrderAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<readonly OrderDto[]> {
    paidSteps.ran.push("split");
    this.spendRecorder.record({ service: "order-api", cost: usd(paidSteps.charge) });
    const { orderId } = input.order.value;
    return Promise.resolve([{ orderId: `${orderId}-a` }, { orderId: `${orderId}-b` }]);
  }
}

@startOf("held-items")
export class HeldItemsWorkflowStart {}
@finishOf("held-items")
export class HeldItemsWorkflowFinish {}

/** Booked, split past the budgets, then the refund launched per part. */
@Workflow({
  name: "held-items-workflow",
  version: "1.0.0",
  flow: [
    start(HeldItemsWorkflowStart)
      .returns(OrderDto)
      .toAction(BookOrderAction)
      .toAction(SplitOrderAction)
      .returns(listOf(OrderDto))
      .toParallelActions(RefundOrderAction, { maxItems: 2 })
      .join()
      .toFinish(HeldItemsWorkflowFinish),
  ],
})
export class HeldItemsWorkflow {}

@startOf("held-local")
export class HeldLocalWorkflowStart {}
@finishOf("held-local")
export class HeldLocalWorkflowFinish {}

/** The held refund's tree as a child on this instance. */
@Workflow({
  name: "held-local-workflow",
  version: "1.0.0",
  flow: [
    start(HeldLocalWorkflowStart)
      .returns(OrderDto)
      .toWorkflow(HeldBranchWorkflow)
      .returns(OrderDto)
      .toFinish(HeldLocalWorkflowFinish),
  ],
})
export class HeldLocalWorkflow {}

@startOf("held-any")
export class HeldAnyWorkflowStart {}
@finishOf("held-any")
export class HeldAnyWorkflowFinish {}

/** The held refund's tree as a child on any instance. */
@Workflow({
  name: "held-any-workflow",
  version: "1.0.0",
  flow: [
    start(HeldAnyWorkflowStart)
      .returns(OrderDto)
      .toWorkflow(HeldBranchWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(OrderDto)
      .toFinish(HeldAnyWorkflowFinish),
  ],
})
export class HeldAnyWorkflow {}

@Application({
  name: "held-branch-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HeldBranchWorkflow, HeldItemsWorkflow, HeldLocalWorkflow, HeldAnyWorkflow],
  observers: [PaidStepsLog, ExemptionsLog],
  budgets: TEST_BUDGETS,
})
export class HeldBranchApplication {}
