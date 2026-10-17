import { Agent } from "agboss";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";
import { ShortlistDto } from "../dtos/shortlist.dto.js";

/** Drafts the offer from the shortlist. */
@Agent({
  name: "draft-agent",
  description: "Drafts the offer",
  promptUrls: ["./draft.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: OfferDraftDto,
})
export class DraftAgent {}
