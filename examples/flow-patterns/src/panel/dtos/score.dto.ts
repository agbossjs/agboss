import { Integer, Text } from "@agboss/core/dto";

/** One panelist's score of the candidate, with its reason. */
export class ScoreDto {
  @Integer({ prompt: "the score, 1–10" })
  score!: number;

  @Text({ prompt: "why this score" })
  reason!: string;
}
