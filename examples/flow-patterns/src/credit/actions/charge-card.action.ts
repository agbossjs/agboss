import { Action, optional, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { ChargeResultDto } from "../dtos/charge-result.dto.js";
import { CreditApprovalDto } from "../dtos/credit-approval.dto.js";
import { CreditOrderDto } from "../dtos/credit-order.dto.js";

/** Charges the customer's card for the order; reached from the router and from the approval. */
@Action({
  name: "charge-card-action",
  description: "Charges the customer's card for the order",
  input: {
    order: CreditOrderDto,
    approval: optional(CreditApprovalDto), // present after ApprovalAgent
  },
  output: ChargeResultDto,
})
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ chargeId: `charge-${input.order.value.customerId}` });
  }
}
