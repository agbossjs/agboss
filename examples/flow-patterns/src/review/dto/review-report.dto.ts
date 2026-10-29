import { Integer, Text } from "@agboss/core/dto";

/** The review: the plan, the style notes and every fact check. */
export class ReviewReportDto {
  @Text({ prompt: "the sections to rework" })
  rework!: string;

  @Text({ prompt: "notes on tone and style" })
  style!: string;

  @Integer({ prompt: "how many claims the fact checkers raised" })
  claims!: number;
}
