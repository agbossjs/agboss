import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { days } from "@agboss/core/units";
import { LegalSignOffExternalTask } from "../external-tasks/legal-sign-off.external-task.js";
import { CommitteeDeskService } from "../services/committee-desk.service.js";

/** Shows the contract to the company's lawyer once and waits for the reply (`app.resume`). */
@Channel({
  name: "legal-inbox-channel",
  description: "Asks the company's lawyer on their desk",
  target: LegalSignOffExternalTask,
  ttl: days(14),
  deps: [CommitteeDeskService],
})
export class LegalInboxChannel {
  constructor(private readonly committeeDeskService: CommitteeDeskService) {}

  send(ask: ChannelAsk<LegalSignOffExternalTask>): ChannelOutcome<LegalSignOffExternalTask> {
    this.committeeDeskService.post("Legal", ask.input.title, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}
