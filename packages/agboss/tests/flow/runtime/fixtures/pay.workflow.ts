import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { AGBossError } from "../../../../src/core/errors.js";
import { OneOf, Text } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../../src/index.js";
import { start, toAgent, toFinish } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";

/** A payment failed: the general case. */
export class PaymentError extends AGBossError {
  static override readonly code: string = "test.payment";
}

/** The card was declined: a more specific payment failure. */
export class CardDeclinedError extends PaymentError {
  static override readonly code: string = "test.payment.declined";
}

/** How the charge goes: paid, declined, or another payment failure. */
export class OrderDto {
  @Text({ prompt: "the order id" })
  id!: string;

  @OneOf({ values: ["pay", "decline", "fail", "crash"], prompt: "how the charge goes" })
  outcome!: "pay" | "decline" | "fail" | "crash";
}

export class ReceiptDto {
  @Text({ prompt: "the receipt" })
  text!: string;
}

export class ApologyDto {
  @Text({ prompt: "the apology" })
  text!: string;
}

/** Charges the order; what it throws is the step's failure (`ActionFailedError`, the cause kept). */
@Action({
  name: "charge-action",
  description: "Charges the card",
  input: { order: OrderDto },
  output: ReceiptDto,
})
export class ChargeAction {
  execute(input: { readonly order: { readonly value: OrderDto } }): Promise<ReceiptDto> {
    const { id, outcome } = input.order.value;
    if (outcome === "decline") return Promise.reject(new CardDeclinedError(`card for ${id}`));
    if (outcome === "fail") return Promise.reject(new PaymentError(`payment for ${id}`));
    if (outcome === "crash") return Promise.reject(new Error("the ledger is down"));
    return Promise.resolve({ text: `paid ${id}` });
  }
}

export class RefundQuery {
  @Text({ prompt: "the order to refund" })
  id!: string;
}

/** A write tool: the run pauses for an approval before it. */
@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  channel: TerminalUserChannel,
  input: RefundQuery,
  output: RefundQuery,
})
export class RefundTool implements ToolHandler<RefundQuery, RefundQuery> {
  run(input: RefundQuery): Promise<RefundQuery> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "apologizer-agent",
  description: "Apologizes for a declined card, refunding what was taken",
  prompt: "Apologize; refund the order.",
  model: "test/apologizer",
  tools: [RefundTool],
  input: { order: OrderDto },
  output: ApologyDto,
})
export class ApologizerAgent {}

@WorkflowStart({ name: "pay-workflow-start", description: "An order to charge", input: OrderDto })
export class PayStart {}

@WorkflowFinish({ name: "paid-workflow-finish", description: "Paid", output: ReceiptDto })
export class PaidFinish {}

@WorkflowFinish({
  name: "payment-failed-workflow-finish",
  description: "Not paid",
  output: OrderDto,
})
export class PaymentFailedFinish {}

@WorkflowFinish({
  name: "declined-workflow-finish",
  description: "Declined, with an apology",
  output: ApologyDto,
})
export class DeclinedFinish {}

/**
 * pay → charge → paid; a declined card goes to the apologizer (which pauses for a refund), any
 * other payment failure to its own finish; a failure of another class fails the execution.
 */
@Workflow({
  name: "pay-workflow",
  version: "1.0.0",
  flow: [
    start(PayStart)
      .returns(OrderDto)
      .toAction(ChargeAction)
      .onError(PaymentError, toFinish(PaymentFailedFinish))
      .onError(
        CardDeclinedError,
        toAgent(ApologizerAgent)
          .returns(ApologyDto)
          .toFinish(DeclinedFinish),
      )
      .returns(ReceiptDto)
      .toFinish(PaidFinish),
  ],
})
export class PayWorkflow {}

@Application({
  name: "pay-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PayWorkflow],
  budgets: TEST_BUDGETS,
})
export class PayApplication {}
