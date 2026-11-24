import { WorkflowFinish } from "@agboss/core";
import { ReviewReportDto } from "../../dto/review-report.dto.js";

/** Where a review finishes: the plan, the style notes and both fact checks, as one report. */
@WorkflowFinish({
  name: "review-workflow-finish",
  description: "The review",
  output: ReviewReportDto,
})
export class ReviewWorkflowFinish {}
