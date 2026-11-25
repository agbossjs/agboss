import { Bool } from "@agboss/core/dto";

/** The approved offer was sent. */
export class OfferSentDto {
  @Bool({ prompt: "the offer was delivered" })
  delivered!: boolean;
}
