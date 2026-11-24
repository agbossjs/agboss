import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { days } from "@agboss/core/units";
import { SecuritySignOffExternalTask } from "../external-tasks/security-sign-off.external-task.js";
import { CommitteeDeskService } from "../services/committee-desk.service.js";

/** Shows the contract to the security team once and waits for the reply (`app.resume`). */
@Channel({
  name: "security-inbox-channel",
  description: "Asks the security team on their desk",
  target: SecuritySignOffExternalTask,
  ttl: days(14),
  deps: [CommitteeDeskService],
})
export class SecurityInboxChannel {
  constructor(private readonly committeeDeskService: CommitteeDeskService) {}

  send(ask: ChannelAsk<SecuritySignOffExternalTask>): ChannelOutcome<SecuritySignOffExternalTask> {
    this.committeeDeskService.post("Security", ask.input.title, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}
