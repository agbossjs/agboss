import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

/** The helpline's answer. */
@WorkflowFinish({
  name: "helpline-answer-workflow-finish",
  description: "The answer to the caller",
  output: WorkflowFinishTextDto,
})
export class HelplineAnswerWorkflowFinish {}
