import { onAgent, onStart, toAction, toAgent, VisitsLimitExceededError, Workflow } from "@agboss/core";
import { NotifyRecruiterAction } from "../../actions/notify-recruiter.action.js";
import { SendOfferAction } from "../../actions/send-offer.action.js";
import { DraftAgent } from "../../agents/draft/draft.agent.js";
import { EditorAgent } from "../../agents/editor/editor.agent.js";
import { ReviewerAgent } from "../../agents/reviewer/reviewer.agent.js";
import { ChangesRequestedDto } from "../../dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../dto/draft-approved.dto.js";
import { OfferMailer } from "../../services/offer-mailer.service.js";
import { RecruiterInbox } from "../../services/recruiter-inbox.service.js";
import { OfferFailedWorkflowFinish } from "./offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "./offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "./offer.workflow-start.js";

/**
 * A review loop (#272, CLAUDE.md → The flow: paths): draft → reviewer, then reviewer → editor →
 * reviewer until it approves. The reviewer is reached from two places, so its `.toOneOf([…])` is a path
 * of its own; the editor's `maxVisits` spent is taken by `.onError(VisitsLimitExceededError, …)`.
 */
@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    onStart(OfferWorkflowStart)
      .toAgent(DraftAgent)
      .toAgent(ReviewerAgent),

    onAgent(ReviewerAgent)
      .toOneOf([
        // the editor reads the requested changes: that tells this branch apart
        toAgent(EditorAgent)
          .onError(
            VisitsLimitExceededError, // the editor's maxVisits spent: tell the recruiter, finish
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish),
          )
          .toAgent(ReviewerAgent),
        toAction(SendOfferAction)
          .toFinish(OfferSentWorkflowFinish),
      ]),
  ],
  executionLimits: { maxSteps: 12 },
  providers: [RecruiterInbox, OfferMailer],
})
export class OfferWorkflow {}
