import { Action, ExecutionContext, type ActionHandler, type InputOf } from "agboss";
import { OnboardingSlotDto } from "../dtos/offer.dto.js";
import { HrCalendarService } from "../services/hr-calendar.service.js";

/** The undo of `book-onboarding-slot-action`: an ordinary @Action, safe to run twice. */
@Action({
  name: "release-onboarding-slot-action",
  description: "Releases the onboarding slot booked in the HR calendar",
  input: { slot: OnboardingSlotDto },
  deps: [HrCalendarService, ExecutionContext],
})
export class ReleaseOnboardingSlotAction implements ActionHandler<ReleaseOnboardingSlotAction> {
  constructor(
    private readonly hrCalendarService: HrCalendarService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReleaseOnboardingSlotAction>): Promise<void> {
    await this.hrCalendarService.releaseSlot(
      input.slot.value.slotId,
      this.executionContext.step.idempotencyKey,
    );
  }
}
