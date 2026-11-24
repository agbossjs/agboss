import { onStart, StepFailedError, toAction, Workflow, toFinish, Ttl } from "@agboss/core";
import { MarkVendorFailedAction } from "../../actions/mark-vendor-failed.action.js";
import { VendorCheckerAgent } from "../../agents/vendor-checker/vendor-checker.agent.js";
import { VendorRejectedDto } from "../../dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../../dto/vendor-score.dto.js";
import { VendorCheckFailedWorkflowFinish } from "./vendor-check-failed.workflow-finish.js";
import { VendorRejectedWorkflowFinish } from "./vendor-rejected.workflow-finish.js";
import { VendorScoredWorkflowFinish } from "./vendor-scored.workflow-finish.js";
import { VendorCheckWorkflowStart } from "./vendor-check.workflow-start.js";

/**
 * The child (#263): an ordinary workflow — one vendor, its own branches and its own steps, run
 * alone with `app.execute(VendorCheckWorkflowStart, …)` or as a step of the screening. It catches
 * its own failure and ends at a finish of its own, so its parent gets one more result class instead
 * of a cancelled launch.
 */
@Workflow({
  name: "vendor-check-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(VendorCheckWorkflowStart)
      .toAgent(VendorCheckerAgent)
      .onError(
        StepFailedError, // the child catches its own failure: one more class for its parent
        toAction(MarkVendorFailedAction)
          .toFinish(VendorCheckFailedWorkflowFinish),
      )
      .toOneOf([toFinish(VendorScoredWorkflowFinish), toFinish(VendorRejectedWorkflowFinish)]),
  ],
})
export class VendorCheckWorkflow {}
