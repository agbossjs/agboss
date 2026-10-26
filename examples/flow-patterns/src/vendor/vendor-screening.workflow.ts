import { listOf, oneOf, start, Workflow } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { VendorFinderAgent } from "./agents/vendor-finder.agent.js";
import { VendorRankerAgent } from "./agents/vendor-ranker.agent.js";
import { VendorCheckFailedDto } from "./dtos/vendor-check-failed.dto.js";
import { VendorRankingDto } from "./dtos/vendor-ranking.dto.js";
import { VendorRejectedDto } from "./dtos/vendor-rejected.dto.js";
import { VendorScoreDto } from "./dtos/vendor-score.dto.js";
import { VendorDto } from "./dtos/vendor.dto.js";
import { VendorCheckWorkflow } from "./vendor-check.workflow.js";
import { VendorRankingWorkflowFinish } from "./workflow-finishes/vendor-ranking.workflow-finish.js";
import { VendorScreeningWorkflowStart } from "./workflow-starts/vendor-screening.workflow-start.js";

/**
 * A child workflow per item (#263): each vendor the finder lists enters vendor-check-workflow-start
 * — a child execution of its own (its own id, steps and branches; at most three at once) — and the
 * join gives the ranker one result per vendor, in the list's order: the classes of the child's
 * finishes as one polymorphic list.
 */
@Workflow({
  name: "vendor-screening-workflow",
  version: "1.0.0",
  flow: [
    start(VendorScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(VendorFinderAgent)
      .returns(listOf(VendorDto))
      .toParallelWorkflows(VendorCheckWorkflow, { maxConcurrency: 3, maxItems: 20 })
      .join()
      .returns(listOf(oneOf(VendorScoreDto, VendorRejectedDto, VendorCheckFailedDto)))
      .toAgent(VendorRankerAgent)
      .returns(VendorRankingDto)
      .toFinish(VendorRankingWorkflowFinish),
  ],
})
export class VendorScreeningWorkflow {}
