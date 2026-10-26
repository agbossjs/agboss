import { Flag, Text } from "@agboss/core/dto";

/** A full legal check of the candidate's paperwork. */
export class LegalReviewDto {
  @Flag({ prompt: "whether the paperwork is in order" })
  isCleared!: boolean;

  @Text({ prompt: "what the check found" })
  findings!: string;
}

/** A quick screen of the candidate: enough to turn one down. */
export class FastScreenDto {
  @Text({ prompt: "why the candidate is or is not a fit, in one line" })
  verdict!: string;
}
