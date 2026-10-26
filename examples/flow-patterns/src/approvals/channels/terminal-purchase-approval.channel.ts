import { Channel, ChannelOutcome, type ChannelAsk } from "@agboss/core";
import { ApprovalTerminal } from "../services/approval-terminal.service.js";
import { PurchaseApprovalChannel } from "./purchase-approval.channel.js";

/**
 * Asks in the terminal, like `TerminalUserChannel`: prints the purchase once, with its pause's id,
 * and waits. `agboss run` then asks the thread's owner for each waiting pause in turn and resumes
 * it; code answers with `app.resume({ pauseId, decision })`. Two buyers asking at once are two
 * pauses, each printed once — a pause is asked when it is made, never again on a resume.
 */
@Channel({
  name: "terminal-purchase-approval-channel",
  description: "Asks the thread's owner in the terminal",
  deps: [ApprovalTerminal],
})
export class TerminalPurchaseApprovalChannel extends PurchaseApprovalChannel {
  constructor(private readonly approvalTerminal: ApprovalTerminal) {
    super();
  }

  send(ask: ChannelAsk<PurchaseApprovalChannel>): Promise<ChannelOutcome<PurchaseApprovalChannel>> {
    const { item, amountUsd } = ask.value.arguments;
    this.approvalTerminal.print([
      "",
      `[APPROVAL REQUIRED] ${item} for $${String(amountUsd)} (pause ${ask.pauseId})`,
    ]);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
