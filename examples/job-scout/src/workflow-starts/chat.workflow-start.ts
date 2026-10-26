import { WorkflowStartTextDto } from "@agboss/core/dto";
import { WorkflowStart } from "@agboss/core";

/** Where a turn of the chat starts: the job seeker's message. */
@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message from the job seeker",
  input: WorkflowStartTextDto,
})
export class ChatWorkflowStart {}
