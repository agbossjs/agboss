import { ChannelOf, ChannelRole, PauseAnswerer } from "agboss";
import { LetterDelivery } from "../tools/send-offer-letter.dto.js";

/** The role a letter is approved through: the thread's owner — the recruiter — answers. */
@ChannelRole({
  name: "recruiter-approval-channel",
  description: "The recruiter approves an offer letter",
  approves: LetterDelivery,
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class RecruiterApprovalChannel extends ChannelOf<RecruiterApprovalChannel> {}
