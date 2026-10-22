import { Action, ExecutionContext, type ActionHandler, type InputOf } from "agboss";
import { RegisteredOfferDto } from "../dtos/offer.dto.js";
import { AtsClientService } from "../services/ats-client.service.js";

/** The undo of `register-offer-action`: an ordinary @Action, safe to run twice. */
@Action({
  name: "withdraw-offer-action",
  description: "Withdraws the offer registered in the ATS",
  input: { offer: RegisteredOfferDto },
  deps: [AtsClientService, ExecutionContext],
})
export class WithdrawOfferAction implements ActionHandler<WithdrawOfferAction> {
  constructor(
    private readonly atsClientService: AtsClientService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<WithdrawOfferAction>): Promise<void> {
    await this.atsClientService.withdrawOffer(
      input.offer.value.offerId,
      this.executionContext.step.idempotencyKey,
    );
  }
}
