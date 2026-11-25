import { onStart, Workflow, toWorkflow, Ttl } from "@agboss/core";
import { VendorFinderAgent } from "../../agents/vendor-finder/vendor-finder.agent.js";
import { VendorRankerAgent } from "../../agents/vendor-ranker/vendor-ranker.agent.js";
import { VendorCheckWorkflow } from "../vendor-check/vendor-check.workflow.js";
import { VendorRankingWorkflowFinish } from "./vendor-ranking.workflow-finish.js";
import { VendorScreeningWorkflowStart } from "./vendor-screening.workflow-start.js";

/**
 * A child workflow per item (#263): each vendor the finder lists enters vendor-check-workflow-start
 * — a child execution of its own (its own id, steps and branches; at most three at once) — and the
 * join gives the ranker one result per vendor, in the list's order: the classes of the child's
 * finishes as one polymorphic list.
 */
@Workflow({
  name: "vendor-screening-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(VendorScreeningWorkflowStart)
      .toAgent(VendorFinderAgent)
      .forEachItem(toWorkflow(VendorCheckWorkflow), { takeFirst: 20, maxConcurrency: 3 })
      .join()
      .toAgent(VendorRankerAgent)
      .toFinish(VendorRankingWorkflowFinish),
  ],
})
export class VendorScreeningWorkflow {}
