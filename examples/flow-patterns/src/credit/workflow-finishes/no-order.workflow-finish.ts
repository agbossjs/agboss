import { WorkflowFinish } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** Where a run finishes when the message is not an order: the message, handed over as is. */
@WorkflowFinish({
  name: "no-order-workflow-finish",
  description: "The message, not an order",
  output: WorkflowStartTextDto,
})
export class NoOrderWorkflowFinish {}
