import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { ApprovalTerminal } from "../services/approval-terminal.service.js";
import { PurchaseToolApproval } from "./purchase-approval.channel.js";
import { days } from "@agboss/core/units";

/**
 * Asks in the terminal: prints the purchase once, with its pause's id,
 * and waits. `agboss run` then asks the thread's owner for each waiting pause in turn and resumes
 * it; code answers with `app.resume({ pauseId, decision })`. Two buyers asking at once are two
 * pauses, each printed once — a pause is asked when it is made, never again on a resume.
 */
@Channel({
  name: "terminal-purchase-approval-channel",
  description: "Asks the thread's owner in the terminal",
  deps: [ApprovalTerminal],
  target: PurchaseToolApproval,
  ttl: days(1),
})
export class TerminalPurchaseApprovalChannel {
  constructor(private readonly approvalTerminal: ApprovalTerminal) {}

  send(ask: ChannelAsk<PurchaseToolApproval>): Promise<ChannelOutcome<PurchaseToolApproval>> {
    const { item, amountUsd } = ask.input;
    this.approvalTerminal.print([
      "",
      `[APPROVAL REQUIRED] ${item} for $${String(amountUsd)} (pause ${ask.pauseId})`,
    ]);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
