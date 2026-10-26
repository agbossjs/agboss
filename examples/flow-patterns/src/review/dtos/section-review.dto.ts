import { Flag, Text } from "@agboss/core/dto";

/** One section reviewed: it carries the section's title, so the next step needs no second list. */
export class SectionReviewDto {
  @Text({ prompt: "the title of the section reviewed" })
  title!: string;

  @Flag({ prompt: "whether the section is ready" })
  ready!: boolean;

  @Text({ prompt: "what to change, or why it is ready" })
  notes!: string;
}
