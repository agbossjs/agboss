import { WorkflowFinish } from "@agboss/core";
import { LegalReviewDto } from "../../dto/intake.dto.js";

/** Where the full check's group finishes: its review. */
@WorkflowFinish({
  name: "intake-report-workflow-finish",
  description: "The full legal review",
  output: LegalReviewDto,
})
export class IntakeReportWorkflowFinish {}
