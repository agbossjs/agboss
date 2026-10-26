import { WorkflowFinishTextDto } from "@agboss/core/dto";
import { WorkflowFinish } from "@agboss/core";

/** Where a turn of the chat finishes: the answer sent back to the job seeker. */
@WorkflowFinish({
  name: "chat-workflow-finish",
  description: "The answer sent back to the job seeker",
  output: WorkflowFinishTextDto,
})
export class ChatWorkflowFinish {}
