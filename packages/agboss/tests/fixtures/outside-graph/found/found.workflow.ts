import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { start } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/** #497: a workflow whose application file next to it loads in the test's graph. */
@Workflow({
  name: "found-probe-workflow",
  version: "1.0.0",
  flow: [
    start(ProbeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ProbeWorkflowFinish),
  ],
})
export class FoundProbeWorkflow {}
