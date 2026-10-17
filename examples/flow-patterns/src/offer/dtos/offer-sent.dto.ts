import { Flag } from "agboss/dto";

/** The approved offer was sent. */
export class OfferSentDto {
  @Flag({ prompt: "the offer was delivered" })
  delivered!: boolean;
}
