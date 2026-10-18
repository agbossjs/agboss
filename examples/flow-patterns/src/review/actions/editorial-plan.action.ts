import { Action, listOf, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { EditorialPlanDto } from "../dtos/editorial-plan.dto.js";
import { SectionReviewDto } from "../dtos/section-review.dto.js";

/**
 * Between two waves: maps the first wave's reviews — one per section, in the sections' order — to
 * what the second wave reads. Code, no model.
 */
@Action({
  name: "editorial-plan-action",
  description: "Turns the section reviews into the editorial plan",
  input: {
    reviews: listOf(SectionReviewDto),
  },
  output: EditorialPlanDto,
})
export class EditorialPlanAction implements ActionHandler<EditorialPlanAction> {
  execute(input: InputOf<EditorialPlanAction>): Promise<OutputOf<EditorialPlanAction>> {
    const titles = (ready: boolean): string =>
      input.reviews
        .filter((review) => review.value.ready === ready)
        .map((review) => review.value.title)
        .join(", ");
    return Promise.resolve({ rework: titles(false), ready: titles(true) });
  }
}
