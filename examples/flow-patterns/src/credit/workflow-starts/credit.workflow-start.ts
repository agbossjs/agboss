import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** Where a run starts: the customer's message. */
@WorkflowStart({
  name: "credit-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class CreditWorkflowStart {}
