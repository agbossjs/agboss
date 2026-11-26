import { Application } from "../../../../src/application/application.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { Ttl } from "../../../../src/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { ProbeWorkflowFinish, ProbeWorkflowStart } from "../parts.js";

/**
 * #497: what a second module graph gives — the application lists a `TwinProbeWorkflow`, but another
 * class object than the test's (as twin.workflow.ts loaded a second time would be).
 */
@Workflow({
  name: "twin-probe-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ProbeWorkflowStart).toFinish(ProbeWorkflowFinish)],
})
class TwinProbeWorkflow {}

@Application({
  name: "twin-probe-application",
  version: "1.0.0",
  workflows: [TwinProbeWorkflow],
  budgets: TEST_BUDGETS,
})
export class TwinProbeApplication {}
