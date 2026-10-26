import { StepFailedError, Workflow, start, toAction } from "@agboss/core";
import { AlertRecruiterAction } from "./actions/alert-recruiter.action.js";
import { BookOnboardingSlotAction } from "./actions/book-onboarding-slot.action.js";
import { ConfirmOfferAction } from "./actions/confirm-offer.action.js";
import { RegisterOfferAction } from "./actions/register-offer.action.js";
import { ReleaseOnboardingSlotAction } from "./actions/release-onboarding-slot.action.js";
import { WithdrawOfferAction } from "./actions/withdraw-offer.action.js";
import { OfferLetterAgent } from "./agents/offer-letter.agent.js";
import { OfferSenderAgent } from "./agents/offer-sender.agent.js";
import {
  OfferConfirmedDto,
  OfferLetterDto,
  OfferLetterSentDto,
  OfferRequestDto,
  OnboardingSlotDto,
  RegisteredOfferDto,
} from "./dtos/offer.dto.js";
import { AtsClientService, AtsUnavailableError } from "./services/ats-client.service.js";
import { HrCalendarService } from "./services/hr-calendar.service.js";
import { RecruiterDeskService } from "./services/recruiter-desk.service.js";
import { OfferConfirmedWorkflowFinish } from "./workflow-finishes/offer-confirmed.workflow-finish.js";
import { OfferWithdrawnWorkflowFinish } from "./workflow-finishes/offer-withdrawn.workflow-finish.js";
import { SendOfferWorkflowStart } from "./workflow-starts/send-offer.workflow-start.js";

/**
 * Declared compensation (#339): two undoable steps — the offer in the ATS, the onboarding slot —
 * each with `compensateWith` and `committedBy: ConfirmOfferAction`. The letter's side path undoes
 * both, newest first, and `agboss check` proves it: leave an undo out, or swap them, and the check
 * fails (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`). A failure the flow
 * does not take (the sender's, a budget, a cancel while it waits) is undone automatically, newest
 * first, before the execution ends (#340).
 */
@Workflow({
  name: "send-offer-workflow",
  version: "1.0.0",
  flow: [
    start(SendOfferWorkflowStart)
      .returns(OfferRequestDto)
      .toAction(RegisterOfferAction)
      .returns(RegisteredOfferDto)
      .toAction(BookOnboardingSlotAction)
      .returns(OnboardingSlotDto)
      .toAgent(OfferLetterAgent)
      .onError(
        StepFailedError, // the letter failed: undo both, newest first — checked by agboss check
        toAction(ReleaseOnboardingSlotAction)
          .toAction(WithdrawOfferAction)
          .onError(
            AtsUnavailableError, // the undo itself failed: a person takes over
            toAction(AlertRecruiterAction)
              .toFinish(OfferWithdrawnWorkflowFinish),
          )
          .toFinish(OfferWithdrawnWorkflowFinish),
      )
      .returns(OfferLetterDto)
      .toAgent(OfferSenderAgent) // pauses for the recruiter
      .returns(OfferLetterSentDto)
      .toAction(ConfirmOfferAction) // commits both undoable steps
      .returns(OfferConfirmedDto)
      .toFinish(OfferConfirmedWorkflowFinish),
  ],
  providers: [AtsClientService, HrCalendarService, RecruiterDeskService],
})
export class SendOfferWorkflow {}
