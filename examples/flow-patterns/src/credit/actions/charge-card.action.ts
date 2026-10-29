import {
  Action,
  ExecutionContext,
  optional,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { ChargeResultDto } from "../dto/charge-result.dto.js";
import { CreditApprovalDto } from "../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../dto/credit-order.dto.js";
import { PaymentService } from "../services/payment.service.js";

/**
 * Charges the customer's card for the order; reached from the router and from the approval. A
 * side effect: the step runs at least once, so the charge carries the step's idempotency key and
 * the payment provider makes one charge per key (`PaymentService`).
 */
@Action({
  name: "charge-card-action",
  description: "Charges the customer's card for the order",
  input: {
    order: CreditOrderDto,
    approval: optional(CreditApprovalDto), // present after ApprovalAgent
  },
  output: ChargeResultDto,
  deps: [ExecutionContext, PaymentService],
})
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly paymentService: PaymentService,
  ) {}

  async execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    const { customerId, total } = input.order.value;
    const charge = await this.paymentService.charge({
      customerId,
      total,
      idempotencyKey: this.executionContext.step.idempotencyKey, // the same on a recovered retry
    });
    return { chargeId: charge.chargeId };
  }
}
