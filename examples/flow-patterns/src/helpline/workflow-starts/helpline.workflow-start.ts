import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** A caller's message to the helpline. */
@WorkflowStart({
  name: "helpline-workflow-start",
  description: "A caller's message, with their customer id",
  input: WorkflowStartTextDto,
})
export class HelplineWorkflowStart {}
