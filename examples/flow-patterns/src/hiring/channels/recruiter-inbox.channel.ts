import { Channel, ChannelOutcome, type ChannelAsk } from "agboss";
import { RecruiterDeskService } from "../services/recruiter-desk.service.js";
import { RecruiterApprovalChannel } from "./recruiter-approval.channel.js";

/** Shows the letter to the recruiter once and waits for the reply (`app.resume`). */
@Channel({
  name: "recruiter-inbox-channel",
  description: "Asks the recruiter on their desk",
  deps: [RecruiterDeskService],
})
export class RecruiterInboxChannel extends RecruiterApprovalChannel {
  constructor(private readonly recruiterDeskService: RecruiterDeskService) {
    super();
  }

  send(
    ask: ChannelAsk<RecruiterApprovalChannel>,
  ): Promise<ChannelOutcome<RecruiterApprovalChannel>> {
    this.recruiterDeskService.post(ask.value.arguments.text, ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
