import { Agent } from "@agboss/core";
import { CreditApprovalDto } from "../../dto/credit-approval.dto.js";
import { CreditOrderDto } from "../../dto/credit-order.dto.js";

/** Approves an order over the customer's credit limit, or not. */
@Agent({
  name: "approval-agent",
  description: "Approves a large order",
  promptUrls: ["./approval.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    order: CreditOrderDto,
  },
  output: CreditApprovalDto,
})
export class ApprovalAgent {}
