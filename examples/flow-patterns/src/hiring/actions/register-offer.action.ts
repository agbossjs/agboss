import {
  Action,
  ExecutionContext,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { OfferRequestDto, RegisteredOfferDto } from "../dto/offer.dto.js";
import { AtsClientService } from "../services/ats-client.service.js";
import { ConfirmOfferAction } from "./confirm-offer.action.js";
import { WithdrawOfferAction } from "./withdraw-offer.action.js";

/** Registers the offer — an undoable step (#339): `compensateWith` undoes it, `committedBy` commits it. */
@Action({
  name: "register-offer-action",
  description: "Registers the offer in the ATS",
  input: { request: OfferRequestDto },
  output: RegisteredOfferDto,
  compensateWith: WithdrawOfferAction, // undoes it; reads only what the path holds right after it
  committedBy: ConfirmOfferAction, // after this one succeeds, nothing undoes it any more
  deps: [AtsClientService, ExecutionContext],
})
export class RegisterOfferAction implements ActionHandler<RegisterOfferAction> {
  constructor(
    private readonly atsClientService: AtsClientService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<RegisterOfferAction>): Promise<OutputOf<RegisterOfferAction>> {
    const { candidateId, role } = input.request.value;
    const key: string = this.executionContext.step.idempotencyKey;
    return { offerId: await this.atsClientService.registerOffer(candidateId, role, key) };
  }
}
