import { AGBossError } from "../../../src/core/errors.js";
import {
  Agent,
  EmptyEnvironment,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish, toAction, toAgent } from "../../helpers/flow.js";
import {
  BatchSummaryDto,
  ConfirmOrderTool,
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  AutoRefundChannel,
  OrderConfirmationDto,
  PauseLog,
  RefundDoneDto,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #267 AC10 with `.onError(…)`: a payout confirms the order with the customer (a pause) while
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
  prompt: inline("Confirm the order."),
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmOrderTool],
  input: { request: RefundRequestDto },
  output: OrderConfirmationDto,
})
export class PayoutConfirmAgent {}

@Agent({
  name: "payout-refund-agent",
  description: "Refunds the order",
  prompt: inline("Refund the order."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class PayoutRefundAgent {}

@Action({
  name: "payout-action",
  description: "The payout",
  input: { confirmation: OrderConfirmationDto, refund: RefundDoneDto },
  output: BatchSummaryDto,
})
export class PayoutAction {
  async execute(input: {
    readonly confirmation: Tracked<OrderConfirmationDto>;
    readonly refund: Tracked<RefundDoneDto>;
  }): Promise<BatchSummaryDto> {
    return { text: `paid ${input.refund.orderId}` };
  }
}

@WorkflowFinish({
  name: "payout-workflow-finish",
  description: "The payout",
  output: BatchSummaryDto,
})
export class PayoutWorkflowFinish {}

@Action({
  name: "payout-declined-action",
  description: "The payout was declined",
  input: { request: RefundRequestDto },
  output: BatchSummaryDto,
})
export class PayoutDeclinedAction {
  async execute(input: { readonly request: Tracked<RefundRequestDto> }): Promise<BatchSummaryDto> {
    return { text: `declined ${input.request.orderId}` };
  }
}

@WorkflowFinish({
  name: "payout-declined-workflow-finish",
  description: "The payout was declined",
  output: BatchSummaryDto,
})
export class PayoutDeclinedWorkflowFinish {}

const providers = [
  FinanceDeskRefundApprovalChannel,
  AutoRefundChannel,
  CustomerOrderConfirmationChannel,
  SeenPausedExecutionRepository,
];

/** Its own handler for the domain error. */
@Workflow({
  name: "payout-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PayoutWorkflowStart)
      .inParallel([toAgent(PayoutConfirmAgent), toAgent(PayoutRefundAgent)])
      .join()
      .onError(
        PaymentDeclinedError,
        toAction(PayoutDeclinedAction).toFinish(PayoutDeclinedWorkflowFinish),
      )
      .toAction(PayoutAction)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutWorkflow {}

@Application({
  name: "payouts-application",
  modelProvider: TestModelProvider,
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PayoutWorkflowStart)
      .inParallel([toAgent(PayoutConfirmAgent), toAgent(PayoutRefundAgent)])
      .join()
      .onError(
        StepFailedError,
        toAction(PayoutDeclinedAction).toFinish(PayoutDeclinedWorkflowFinish),
      )
      .toAction(PayoutAction)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutStepsWorkflow {}

@Application({
  name: "payout-steps-application",
  modelProvider: TestModelProvider,
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PayoutWorkflowStart)
      .inParallel([toAgent(PayoutConfirmAgent), toAgent(PayoutRefundAgent)])
      .join()
      .toAction(PayoutAction)
      .toFinish(PayoutWorkflowFinish),
  ],
})
export class PayoutUnhandledWorkflow {}

@Application({
  name: "payout-unhandled-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PayoutUnhandledWorkflow],
  providers,
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PayoutUnhandledApplication {}
