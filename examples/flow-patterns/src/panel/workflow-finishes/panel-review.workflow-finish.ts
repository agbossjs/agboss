import { WorkflowFinish } from "@agboss/core";
import { PanelReviewDto } from "../dtos/panel-review.dto.js";

/** Where a panel finishes: the review of the counted scores. */
@WorkflowFinish({
  name: "panel-review-workflow-finish",
  description: "The review of the counted scores",
  output: PanelReviewDto,
})
export class PanelReviewWorkflowFinish {}
