import { WorkflowFinish } from "@agboss/core";
import { ChargeResultDto } from "../dtos/charge-result.dto.js";

/** Where a run finishes when the order was charged. */
@WorkflowFinish({
  name: "credit-workflow-finish",
  description: "The charge",
  output: ChargeResultDto,
})
export class CreditWorkflowFinish {}
