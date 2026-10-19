import { AGBossError } from "../../../src/core/errors.js";
import {
  Agent,
  EmptyEnvironment,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toFinish } from "../../helpers/flow.js";
import {
  BatchSummaryDto,
  ConfirmOrderTool,
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  OrderConfirmationDto,
  PauseLog,
  RefundDoneDto,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";

/**
 * #267 AC10 with `.onJoinError(…)`: a payout confirms the order with the customer (a pause) while
 * its refund branch fails — the finance desk refuses the card with a domain error — so the paused
 * branch is withdrawn and the join routes the branch's error by its class and cause chain: to its
 * own handler, or to `StepFailedError`'s.
 */

/** The card was declined: the domain error the refund branch fails with. */
export class PaymentDeclinedError extends AGBossError {
  static override readonly code: string = "payout.declined";
  override name = "PaymentDeclinedError";
}

@WorkflowStart({ name: "payout-workflow-start", description: "An order", input: RefundRequestDto })
export class PayoutWorkflowStart {}

@Agent({
  name: "payout-confirm-agent",
  description: "Confirms the order with the customer",
  prompt: "Confirm the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmOrderTool],
  input: { request: RefundRequestDto },
  output: OrderConfirmationDto,
})
export class PayoutConfirmAgent {}

@Agent({
  name: "payout-refund-agent",
  description: "Refunds the order",
  prompt: "Refund the order.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class PayoutRefundAgent {}

@WorkflowFinish({
  name: "payout-workflow-finish",
  description: "The payout",
  input: { confirmation: OrderConfirmationDto, refund: RefundDoneDto },
  output: BatchSummaryDto,
})
export class PayoutWorkflowFinish {
  finish(input: {
    readonly confirmation: Produced<OrderConfirmationDto, unknown>;
    readonly refund: Produced<RefundDoneDto, unknown>;
  }): BatchSummaryDto {
    return { text: `paid ${input.refund.value.orderId}` };
  }
}

@WorkflowFinish({
  name: "payout-declined-workflow-finish",
  description: "The payout was declined",
  input: { request: RefundRequestDto },
  output: BatchSummaryDto,
})
export class PayoutDeclinedWorkflowFinish {
  finish(input: { readonly request: Produced<RefundRequestDto, unknown> }): BatchSummaryDto {
    return { text: `declined ${input.request.value.orderId}` };
  }
}

const providers = [
  FinanceDeskRefundApprovalChannel,
  CustomerOrderConfirmationChannel,
  SeenPausedExecutionRepository,
];

/** Its own handler for the domain error. */
@Workflow({
  name: "payout-workflow",
  version: "1.0.0",
  flow: [
    start(PayoutWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PayoutConfirmAgent, PayoutRefundAgent)
      .join()
      .onJoinError(PaymentDeclinedError, toFinish(PayoutDeclinedWorkflowFinish))
      .returns(OrderConfirmationDto)
      .returns(RefundDoneDto)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutWorkflow {}

@Application({
  name: "payouts-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PayoutWorkflow],
  providers,
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PayoutsApplication {}

/** A handler for any step failure: the agent's own error class, above the domain error. */
@Workflow({
  name: "payout-steps-workflow",
  version: "1.0.0",
  flow: [
    start(PayoutWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PayoutConfirmAgent, PayoutRefundAgent)
      .join()
      .onJoinError(StepFailedError, toFinish(PayoutDeclinedWorkflowFinish))
      .returns(OrderConfirmationDto)
      .returns(RefundDoneDto)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutStepsWorkflow {}

@Application({
  name: "payout-steps-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PayoutStepsWorkflow],
  providers,
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PayoutStepsApplication {}

/** No handler: the execution fails with the branch's error as it was thrown. */
@Workflow({
  name: "payout-unhandled-workflow",
  version: "1.0.0",
  flow: [
    start(PayoutWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PayoutConfirmAgent, PayoutRefundAgent)
      .join()
      .returns(OrderConfirmationDto)
      .returns(RefundDoneDto)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutUnhandledWorkflow {}

@Application({
  name: "payout-unhandled-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PayoutUnhandledWorkflow],
  providers,
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PayoutUnhandledApplication {}
