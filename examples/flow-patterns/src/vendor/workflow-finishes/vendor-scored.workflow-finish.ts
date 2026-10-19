import { WorkflowFinish } from "agboss";
import { VendorScoreDto } from "../dtos/vendor-score.dto.js";

/** The vendor is scored. */
@WorkflowFinish({
  name: "vendor-scored-workflow-finish",
  description: "The vendor is scored",
  output: VendorScoreDto,
})
export class VendorScoredWorkflowFinish {}
