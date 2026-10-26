import { Text } from "@agboss/core/dto";

/** The candidates the offer is made from: what a run starts with. */
export class ShortlistDto {
  @Text({ prompt: "the shortlisted candidates" })
  candidates!: string;
}
