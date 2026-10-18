import { Text } from "agboss/dto";

/** What the panel's counted scores come to. */
export class PanelReviewDto {
  @Text({ prompt: "the review of the counted scores" })
  text!: string;
}
