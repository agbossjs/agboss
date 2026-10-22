import { Action, ExecutionContext, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { OfferConfirmedDto, OfferLetterSentDto, RegisteredOfferDto } from "../dtos/offer.dto.js";
import { AtsClientService } from "../services/ats-client.service.js";

/** The commit point: once it succeeds, nothing undoes the offer or the slot any more. */
@Action({
  name: "confirm-offer-action",
  description: "Confirms the offer in the ATS once the letter is sent",
  input: { offer: RegisteredOfferDto, sent: OfferLetterSentDto },
  output: OfferConfirmedDto,
  deps: [AtsClientService, ExecutionContext],
})
export class ConfirmOfferAction implements ActionHandler<ConfirmOfferAction> {
  constructor(
    private readonly atsClientService: AtsClientService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ConfirmOfferAction>): Promise<OutputOf<ConfirmOfferAction>> {
    const { offerId } = input.offer.value;
    await this.atsClientService.confirmOffer(offerId, this.executionContext.step.idempotencyKey);
    return { offerId };
  }
}
