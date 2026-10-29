import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

/** The desk's answer. */
@WorkflowFinish({
  name: "desk-answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class DeskAnswerWorkflowFinish {}
