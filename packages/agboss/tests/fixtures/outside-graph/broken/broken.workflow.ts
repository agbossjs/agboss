import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/** #497: a workflow whose application file next to it fails to load. */
@Workflow({
  name: "broken-probe-workflow",
  version: "1.0.0",
  flow: [
    onStart(ProbeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(ProbeWorkflowFinish),
  ],
})
export class BrokenProbeWorkflow {}
