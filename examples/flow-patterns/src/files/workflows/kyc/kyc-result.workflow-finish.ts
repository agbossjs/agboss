import { WorkflowFinish } from "@agboss/core";
import { WorkflowFinishTextDto } from "@agboss/core/dto";

/** What the agent made of the files. */
@WorkflowFinish({
  name: "kyc-result-workflow-finish",
  description: "What the agent made of the files",
  output: WorkflowFinishTextDto,
})
export class KycResultWorkflowFinish {}
