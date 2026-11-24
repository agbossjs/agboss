import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/** #497: the workflow a test imports; its application lists a class of the same name, not it. */
@Workflow({
  name: "twin-probe-workflow",
  version: "1.0.0",
  flow: [
    onStart(ProbeWorkflowStart)
      .toFinish(ProbeWorkflowFinish),
  ],
})
export class TwinProbeWorkflow {}
