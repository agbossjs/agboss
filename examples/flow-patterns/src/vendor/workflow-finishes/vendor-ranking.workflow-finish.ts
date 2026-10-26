import { WorkflowFinish } from "@agboss/core";
import { VendorRankingDto } from "../dtos/vendor-ranking.dto.js";

/** Where a screening finishes: the ranking. */
@WorkflowFinish({
  name: "vendor-ranking-workflow-finish",
  description: "The vendors, ranked",
  output: VendorRankingDto,
})
export class VendorRankingWorkflowFinish {}
