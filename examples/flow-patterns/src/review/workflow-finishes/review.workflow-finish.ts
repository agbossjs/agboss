import { listOf, WorkflowFinish, type FinishHandler, type InputOf, type OutputOf } from "agboss";
import { EditorialPlanDto } from "../dtos/editorial-plan.dto.js";
import { FactCheckDto } from "../dtos/fact-check.dto.js";
import { ReviewReportDto } from "../dtos/review-report.dto.js";
import { StyleNotesDto } from "../dtos/style-notes.dto.js";

/** Where a review finishes: the plan, the style notes and both fact checks, as one report. */
@WorkflowFinish({
  name: "review-workflow-finish",
  description: "The review",
  input: {
    plan: EditorialPlanDto,
    style: StyleNotesDto,
    facts: listOf(FactCheckDto), // the two fact checker copies
  },
  output: ReviewReportDto,
})
export class ReviewWorkflowFinish implements FinishHandler<ReviewWorkflowFinish> {
  finish(input: InputOf<ReviewWorkflowFinish>): OutputOf<ReviewWorkflowFinish> {
    const claims = input.facts.filter((fact) => fact.value.claim !== "none").length;
    return { rework: input.plan.value.rework, style: input.style.value.notes, claims };
  }
}
