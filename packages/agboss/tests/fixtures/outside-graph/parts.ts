import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";

/** The start and the finish of the #497 fixtures' workflows: a message handed over as is. */
@WorkflowStart({
  name: "probe-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ProbeWorkflowStart {}

@WorkflowFinish({
  name: "probe-workflow-finish",
  description: "The message, as is",
  output: WorkflowStartTextDto,
})
export class ProbeWorkflowFinish {}
