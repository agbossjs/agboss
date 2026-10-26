import { Action, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";
import { OfferSentDto } from "../dtos/offer-sent.dto.js";
import { OfferMailer } from "../services/offer-mailer.service.js";

/** Sends the approved offer. */
@Action({
  name: "send-offer-action",
  description: "Sends the approved offer",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferSentDto,
  deps: [OfferMailer],
})
export class SendOfferAction implements ActionHandler<SendOfferAction> {
  constructor(private readonly mailer: OfferMailer) {}

  async execute(input: InputOf<SendOfferAction>): Promise<OutputOf<SendOfferAction>> {
    return { delivered: await this.mailer.send(input.draft.value.text) };
  }
}
