import { Agent, historyOf, oneOf } from "agboss";
import { ChangesRequestedDto } from "../dtos/changes-requested.dto.js";
import { DraftApprovedDto } from "../dtos/draft-approved.dto.js";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";

/**
 * Reviews the draft: requests changes or approves it. Reached from the draft and from the editor,
 * so its path is its own (`agent(ReviewerAgent).returns(oneOf(…)).switch(…)`); the flow says its
 * change requests are about the draft (`caseOf(ChangesRequestedDto, { about: OfferDraftDto })`) — a
 * rewrite outdates the old request. It reads the draft with its last earlier version
 * (`historyOf(OfferDraftDto, { limit: 1 })` — `{ current, previous }`), to judge what changed.
 */
@Agent({
  name: "reviewer-agent",
  description: "Reviews the draft",
  promptUrls: ["./reviewer.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: historyOf(OfferDraftDto, { limit: 1 }),
  },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
})
export class ReviewerAgent {}
