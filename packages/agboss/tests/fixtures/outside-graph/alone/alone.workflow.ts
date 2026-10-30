import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { start } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/** #497: a workflow no application lists — assembled on its own, no error. */
@Workflow({
  name: "alone-probe-workflow",
  version: "1.0.0",
  flow: [
    start(ProbeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ProbeWorkflowFinish),
  ],
})
export class AloneProbeWorkflow {}
