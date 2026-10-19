import { Channel } from "../components/decorators.js";
import { agbossComponent } from "../flow/generated-types.js";
import { ChannelOutcome } from "./channel-outcome.js";

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

  send(): Promise<ChannelOutcome<AutoApproveChannel>> {
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

  send(): Promise<ChannelOutcome<AutoRejectChannel>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: false, reason: "rejected automatically" }),
    );
  }
}
