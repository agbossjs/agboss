import { Channel } from "../components/decorators.js";
import { agbossComponent } from "../flow/generated-types.js";
import { ChannelOutcome, type DecidedOutcome } from "./channel-outcome.js";
import type { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";

/**
 * What a built-in test channel decides: an approval or a refusal, never corrected arguments — so it
 * fits any role that approves a tool (`override(RefundApprovalRole, AutoApproveChannel)`, #267 S104).
 */
export type AutoDecision = Pick<ToolCallApprovalDecisionDto, "approved" | "reason">;

/**
 * Approves every call at once (`ChannelOutcome.decided`): no pause, no pause record — for tests and
 * scripts, named on a tool as is; the decision's `by` is the channel's name. A role's
 * implementation is scripted in a test with `mockOf(Implementation).send`.
 */
@Channel({
  name: "auto-approve-channel",
  description: "Automatically approves any request (for tests)",
})
export class AutoApproveChannel {
  declare readonly [agbossComponent]?: "auto-approve-channel";

  send(): Promise<DecidedOutcome<AutoDecision>> {
    return Promise.resolve(ChannelOutcome.decided({ approved: true }));
  }
}

/** Rejects every call at once (`ChannelOutcome.decided`): no pause — for tests and scripts. */
@Channel({
  name: "auto-reject-channel",
  description: "Automatically rejects any request (for tests)",
})
export class AutoRejectChannel {
  declare readonly [agbossComponent]?: "auto-reject-channel";

  send(): Promise<DecidedOutcome<AutoDecision>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: false, reason: "rejected automatically" }),
    );
  }
}
