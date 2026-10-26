import { WorkflowFinish } from "@agboss/core";
import { CreditOrderDto } from "../dtos/credit-order.dto.js";

/** Where a run finishes when the credit service is down: the order, held. */
@WorkflowFinish({
  name: "order-held-workflow-finish",
  description: "The order, held until the credit service answers",
  output: CreditOrderDto,
})
export class OrderHeldWorkflowFinish {}
