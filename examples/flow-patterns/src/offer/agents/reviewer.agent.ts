import { about, Agent, oneOf } from "agboss";
import { ChangesRequestedDto } from "../dtos/changes-requested.dto.js";
import { DraftApprovedDto } from "../dtos/draft-approved.dto.js";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";

/**
 * Reviews the draft: requests changes or approves it. Reached from the draft and from the editor,
 * so its path is its own (`agent(ReviewerAgent).switch(…)`); its verdicts are about the draft
 * (`about(OfferDraftDto, …)`) — a rewrite outdates the old verdict.
 */
@Agent({
  name: "reviewer-agent",
  description: "Reviews the draft",
  promptUrls: ["./reviewer.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: about(OfferDraftDto, oneOf(ChangesRequestedDto, DraftApprovedDto)),
})
export class ReviewerAgent {}
