import { Text } from "@agboss/core/dto";

/** What the panel's counted scores come to. */
export class PanelReviewDto {
  @Text({ prompt: "the review of the counted scores" })
  text!: string;
}
