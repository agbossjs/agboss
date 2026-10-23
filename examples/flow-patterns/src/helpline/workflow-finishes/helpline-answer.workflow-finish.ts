import { WorkflowFinish } from "agboss";
import { WorkflowFinishTextDto } from "agboss/dto";

/** The helpline's answer. */
@WorkflowFinish({
  name: "helpline-answer-workflow-finish",
  description: "The answer to the caller",
  output: WorkflowFinishTextDto,
})
export class HelplineAnswerWorkflowFinish {}
