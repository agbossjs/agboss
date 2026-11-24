import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { days } from "@agboss/core/units";
import { FinanceDirectorSignOffExternalTask } from "../external-tasks/finance-director-sign-off.external-task.js";
import { CommitteeDeskService } from "../services/committee-desk.service.js";

/** Shows the contract to the finance director once and waits for the reply (`app.resume`). */
@Channel({
  name: "finance-director-inbox-channel",
  description: "Asks the finance director on their desk",
  target: FinanceDirectorSignOffExternalTask,
  ttl: days(14),
  deps: [CommitteeDeskService],
})
export class FinanceDirectorInboxChannel {
  constructor(private readonly committeeDeskService: CommitteeDeskService) {}

  send(
    ask: ChannelAsk<FinanceDirectorSignOffExternalTask>,
  ): ChannelOutcome<FinanceDirectorSignOffExternalTask> {
    this.committeeDeskService.post("FinanceDirector", ask.value.title, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}
