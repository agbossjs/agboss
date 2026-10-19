import { caseOf, oneOf, start, StepFailedError, toAction, Workflow } from "agboss";
import { MarkVendorFailedAction } from "./actions/mark-vendor-failed.action.js";
import { VendorCheckerAgent } from "./agents/vendor-checker.agent.js";
import { VendorCheckFailedDto } from "./dtos/vendor-check-failed.dto.js";
import { VendorRejectedDto } from "./dtos/vendor-rejected.dto.js";
import { VendorScoreDto } from "./dtos/vendor-score.dto.js";
import { VendorDto } from "./dtos/vendor.dto.js";
import { VendorCheckFailedWorkflowFinish } from "./workflow-finishes/vendor-check-failed.workflow-finish.js";
import { VendorRejectedWorkflowFinish } from "./workflow-finishes/vendor-rejected.workflow-finish.js";
import { VendorScoredWorkflowFinish } from "./workflow-finishes/vendor-scored.workflow-finish.js";
import { VendorCheckWorkflowStart } from "./workflow-starts/vendor-check.workflow-start.js";

/**
 * The child (#263): an ordinary workflow — one vendor, its own branches and its own steps, run
 * alone with `app.execute(VendorCheckWorkflowStart, …)` or as a step of the screening. It catches
 * its own failure and ends at a finish of its own, so its parent gets one more result class instead
 * of a cancelled launch.
 */
@Workflow({
  name: "vendor-check-workflow",
  version: "1.0.0",
  flow: [
    start(VendorCheckWorkflowStart)
      .returns(VendorDto)
      .toAgent(VendorCheckerAgent)
      .onError(
        StepFailedError, // the child catches its own failure: one more class for its parent
        toAction(MarkVendorFailedAction)
          .returns(VendorCheckFailedDto)
          .toFinish(VendorCheckFailedWorkflowFinish),
      )
      .returns(oneOf(VendorScoreDto, VendorRejectedDto))
      .switch(
        caseOf(VendorScoreDto)
          .toFinish(VendorScoredWorkflowFinish),
        caseOf(VendorRejectedDto)
          .toFinish(VendorRejectedWorkflowFinish),
      ),
  ],
})
export class VendorCheckWorkflow {}
