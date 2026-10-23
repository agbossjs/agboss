import { WorkflowFinish } from "agboss";
import { WorkflowFinishTextDto } from "agboss/dto";

/** The desk's answer. */
@WorkflowFinish({
  name: "desk-answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class DeskAnswerWorkflowFinish {}
