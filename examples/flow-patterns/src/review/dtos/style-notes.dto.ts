import { Text } from "agboss/dto";

/** The style critic's notes on the plan. */
export class StyleNotesDto {
  @Text({ prompt: "notes on tone and style" })
  notes!: string;
}
