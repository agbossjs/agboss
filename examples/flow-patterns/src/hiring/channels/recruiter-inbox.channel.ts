import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { RecruiterDeskService } from "../services/recruiter-desk.service.js";
import { RecruiterToolApproval } from "./recruiter-approval.channel.js";
import { days } from "../../../../../packages/agboss/src/units/index.js";

/** Shows the letter to the recruiter once and waits for the reply (`app.resume`). */
@Channel({
  name: "recruiter-inbox-channel",
  description: "Asks the recruiter on their desk",
  deps: [RecruiterDeskService],
  target: RecruiterToolApproval,
  ttl: days(1),
})
export class RecruiterInboxChannel {
  constructor(private readonly recruiterDeskService: RecruiterDeskService) {}

  send(ask: ChannelAsk<RecruiterToolApproval>): Promise<ChannelOutcome<RecruiterToolApproval>> {
    this.recruiterDeskService.post(ask.input.text, ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
