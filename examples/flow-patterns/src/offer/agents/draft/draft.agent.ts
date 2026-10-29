import { Agent } from "@agboss/core";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";
import { ShortlistDto } from "../../dto/shortlist.dto.js";

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
