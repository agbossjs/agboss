import { Text } from "agboss/dto";

/** The offer as drafted (and rewritten): what the reviewer reviews. */
export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}
