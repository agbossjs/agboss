import {
  agent,
  caseOf,
  start,
  toAction,
  VisitsLimitExceededError,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
} from "agboss";
import { usd } from "agboss/units";
import { NotifyRecruiterAction } from "./actions/notify-recruiter.action.js";
import { SendOfferAction } from "./actions/send-offer.action.js";
import { DraftAgent } from "./agents/draft.agent.js";
import { EditorAgent } from "./agents/editor.agent.js";
import { ReviewerAgent } from "./agents/reviewer.agent.js";
import { ChangesRequestedDto } from "./dtos/changes-requested.dto.js";
import { DraftApprovedDto } from "./dtos/draft-approved.dto.js";
import { OfferDraftDto } from "./dtos/offer-draft.dto.js";
import { OfferSentDto } from "./dtos/offer-sent.dto.js";
import { ShortlistDto } from "./dtos/shortlist.dto.js";
import { OfferMailer } from "./services/offer-mailer.service.js";
import { RecruiterInbox } from "./services/recruiter-inbox.service.js";
import { OfferFailedWorkflowFinish } from "./workflow-finishes/offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "./workflow-finishes/offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "./workflow-starts/offer.workflow-start.js";

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
      .switch(
        caseOf(ChangesRequestedDto)
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
export class OfferWorkflow implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.1) }, perDay: { cost: usd(1) } })
      .build();
  }
}
