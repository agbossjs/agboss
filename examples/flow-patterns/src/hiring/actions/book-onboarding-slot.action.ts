import {
  Action,
  ExecutionContext,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { OnboardingSlotDto, RegisteredOfferDto } from "../dto/offer.dto.js";
import { HrCalendarService } from "../services/hr-calendar.service.js";
import { ConfirmOfferAction } from "./confirm-offer.action.js";
import { ReleaseOnboardingSlotAction } from "./release-onboarding-slot.action.js";

/** A second undoable step: a side path undoes it before the offer — newest first. */
@Action({
  name: "book-onboarding-slot-action",
  description: "Books the candidate's onboarding slot in the HR calendar",
  input: { offer: RegisteredOfferDto },
  output: OnboardingSlotDto,
  compensateWith: ReleaseOnboardingSlotAction,
  committedBy: ConfirmOfferAction,
  deps: [HrCalendarService, ExecutionContext],
})
export class BookOnboardingSlotAction implements ActionHandler<BookOnboardingSlotAction> {
  constructor(
    private readonly hrCalendarService: HrCalendarService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(
    input: InputOf<BookOnboardingSlotAction>,
  ): Promise<OutputOf<BookOnboardingSlotAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { slotId: await this.hrCalendarService.bookSlot(input.offer.value.offerId, key) };
  }
}
