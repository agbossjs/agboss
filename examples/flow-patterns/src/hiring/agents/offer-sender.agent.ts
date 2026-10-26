import { Agent } from "@agboss/core";
import { OfferLetterDto, OfferLetterSentDto } from "../dtos/offer.dto.js";
import { SendOfferLetterTool } from "../tools/send-offer-letter.tool.js";

/** Sends the letter — its tool waits for the recruiter's approval. */
@Agent({
  name: "offer-sender-agent",
  description: "Sends the offer letter once the recruiter approves it",
  promptUrls: ["./offer-sender.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: { letter: OfferLetterDto },
  output: OfferLetterSentDto,
  tools: [SendOfferLetterTool],
})
export class OfferSenderAgent {}
