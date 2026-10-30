import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { start } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/** #497: the workflow a test imports; its application lists a class of the same name, not it. */
@Workflow({
  name: "twin-probe-workflow",
  version: "1.0.0",
  flow: [
    start(ProbeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ProbeWorkflowFinish),
  ],
})
export class TwinProbeWorkflow {}
