import { WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

/** A caller's message to the helpline. */
@WorkflowStart({
  name: "helpline-workflow-start",
  description: "A caller's message, with their customer id",
  input: WorkflowStartTextDto,
})
export class HelplineWorkflowStart {}
