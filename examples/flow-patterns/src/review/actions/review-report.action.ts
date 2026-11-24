import { Action, listOf, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { EditorialPlanDto } from "../dto/editorial-plan.dto.js";
import { FactCheckDto } from "../dto/fact-check.dto.js";
import { ReviewReportDto } from "../dto/review-report.dto.js";
import { StyleNotesDto } from "../dto/style-notes.dto.js";

/** The plan, the style notes and both fact checks, as one report. */
@Action({
  name: "review-report-action",
  description: "The review",
  input: {
    plan: EditorialPlanDto,
    style: StyleNotesDto,
    facts: listOf(FactCheckDto), // the two fact checker copies
  },
  output: ReviewReportDto,
})
export class ReviewReportAction implements ActionHandler<ReviewReportAction> {
  execute(input: InputOf<ReviewReportAction>): Promise<OutputOf<ReviewReportAction>> {
    const claims = input.facts.filter((fact) => fact.claim !== "none").length;
    return Promise.resolve({
      rework: input.plan.rework,
      style: input.style.notes,
      claims,
    });
  }
}
