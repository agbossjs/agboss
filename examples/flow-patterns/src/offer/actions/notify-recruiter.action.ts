import { Action, type ActionHandler, type InputOf } from "@agboss/core";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";
import { RecruiterInbox } from "../services/recruiter-inbox.service.js";

/** Tells the recruiter the offer failed: the editor's visits ran out before an approval. */
@Action({
  name: "notify-recruiter-action",
  description: "Tells the recruiter the offer failed",
  input: {
    draft: OfferDraftDto,
  },
  deps: [RecruiterInbox],
})
export class NotifyRecruiterAction implements ActionHandler<NotifyRecruiterAction> {
  constructor(private readonly inbox: RecruiterInbox) {}

  async execute(input: InputOf<NotifyRecruiterAction>): Promise<void> {
    await this.inbox.notify(`The offer was not approved: ${input.draft.value.text}`);
  }
}
