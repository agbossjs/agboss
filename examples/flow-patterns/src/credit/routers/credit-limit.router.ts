import {
  DecidedBy,
  ExecutionContext,
  Router,
  type InputOf,
  type Route,
  type RouterHandler,
} from "@agboss/core";
import { ApprovalAgent } from "../agents/approval.agent.js";
import { ChargeCardAction } from "../actions/charge-card.action.js";
import { CreditOrderDto } from "../dtos/credit-order.dto.js";
import { CreditService } from "../services/credit.service.js";

/**
 * A router decided by code (#280): `route(input)` returns the target, no model is called. Its
 * services come through `deps`, the current step through the injected `ExecutionContext`.
 */
@Router({
  name: "credit-limit-router",
  description: "Sends large orders for approval, charges the rest",
  decidedBy: DecidedBy.Code,
  input: {
    order: CreditOrderDto,
  },
  routes: [{ target: ApprovalAgent }, { target: ChargeCardAction }],
  deps: [ExecutionContext, CreditService],
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly creditService: CreditService,
  ) {}

  async route(input: InputOf<CreditLimitRouter>): Promise<Route<CreditLimitRouter>> {
    const { customerId, total } = input.order.value;
    const limit = await this.creditService.limitOf({
      customerId,
      requestKey: this.executionContext.step.idempotencyKey,
    });
    return total > limit ? ApprovalAgent : ChargeCardAction;
  }
}
