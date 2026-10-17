import { WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

/** Where a run starts: the customer's message. */
@WorkflowStart({
  name: "credit-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class CreditWorkflowStart {}
