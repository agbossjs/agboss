import { WorkflowFinish } from "@agboss/core";
import { EditorialPlanDto } from "../dtos/editorial-plan.dto.js";

/** Where a review finishes when a critic failed: the plan, reviewed no further. */
@WorkflowFinish({
  name: "review-incomplete-workflow-finish",
  description: "The plan, without the critics' review",
  output: EditorialPlanDto,
})
export class ReviewIncompleteWorkflowFinish {}
