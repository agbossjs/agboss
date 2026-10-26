import { Text } from "@agboss/core/dto";

/** The candidate a panel scores. */
export class CandidateDto {
  @Text({ prompt: "the candidate's name and profile" })
  profile!: string;
}
