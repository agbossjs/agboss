import { Agent } from "agboss";
import { OfferLetterDto, OfferRequestDto } from "../dtos/offer.dto.js";

/** Writes the offer letter from the request. */
@Agent({
  name: "offer-letter-agent",
  description: "Writes the offer letter",
  promptUrls: ["./offer-letter.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { request: OfferRequestDto },
  output: OfferLetterDto,
})
export class OfferLetterAgent {}
