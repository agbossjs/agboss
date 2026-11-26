import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";
import { Ttl } from "../../../../src/index.js";

/** #497: a workflow no application lists — assembled on its own, no error. */
@Workflow({
  name: "alone-probe-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ProbeWorkflowStart).toFinish(ProbeWorkflowFinish)],
})
export class AloneProbeWorkflow {}
