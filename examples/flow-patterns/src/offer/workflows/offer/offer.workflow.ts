import {
  agent,
  caseOf,
  oneOf,
  start,
  toAction,
  VisitsLimitExceededError,
  Workflow,
} from "@agboss/core";
import { NotifyRecruiterAction } from "../../actions/notify-recruiter.action.js";
import { SendOfferAction } from "../../actions/send-offer.action.js";
import { DraftAgent } from "../../agents/draft/draft.agent.js";
import { EditorAgent } from "../../agents/editor/editor.agent.js";
import { ReviewerAgent } from "../../agents/reviewer/reviewer.agent.js";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../dto/draft-approved.dto.js";
import { OfferDraftDto } from "../../dto/offer-draft.dto.js";
import { OfferSentDto } from "../../dto/offer-sent.dto.js";
import { ShortlistDto } from "../../dto/shortlist.dto.js";
import { OfferMailer } from "../../services/offer-mailer.service.js";
import { RecruiterInbox } from "../../services/recruiter-inbox.service.js";
import { OfferFailedWorkflowFinish } from "./offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "./offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "./offer.workflow-start.js";

/**
 * A review loop (#272, CLAUDE.md → The flow: paths): draft → reviewer, then reviewer → editor →
 * reviewer until it approves. The reviewer is reached from two places, so its `switch` is a path
 * of its own; the editor's `maxVisits` spent is taken by `.onError(VisitsLimitExceededError, …)`.
 */
@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewerAgent),

    agent(ReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
          .toAgent(EditorAgent)
          .onError(
            VisitsLimitExceededError, // the editor's maxVisits spent: tell the recruiter, finish
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish),
          )
          .returns(OfferDraftDto)
          .toAgent(ReviewerAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendOfferAction)
          .returns(OfferSentDto)
          .toFinish(OfferSentWorkflowFinish),
      ),
  ],
  maxSteps: 12,
  providers: [RecruiterInbox, OfferMailer],
})
export class OfferWorkflow {}
