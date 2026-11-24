import { Channel } from "../components/decorators.js";
import { recordInjectAs, type Class } from "../components/injection.js";
import { agbossComponent } from "../flow/generated-types.js";
import { ChannelOutcome, type DecidedOutcome } from "./channel-outcome.js";
import type { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";

/**
 * What a built-in test channel decides is an approval or a refusal, never corrected arguments — so
 * it fits any role that approves a tool: `testWith(App, { services: [AutoApproveChannel.for(RefundApprovalRole)] })`
 * (#267 S104, #1328).
 *
 * Approves every call at once (`ChannelOutcome.decided`): no pause, no pause record — for tests and
 * scripts, named on a tool as is; the decision's `by` is the channel's name. A role's
 * implementation is scripted in a test with `mockOf(Implementation).send`.
 */
@Channel({
  name: "auto-approve-channel",
  description: "Automatically approves any request (for tests)",
})
export class AutoApproveChannel {
  declare readonly [agbossComponent]?: { readonly name: "auto-approve-channel" };

  /** This channel in the place of a role's (or a pause target's) own: a `services` entry of a test. */
  static for(target: Class): new () => AutoApproveChannel {
    return channelFor(AutoApproveChannel, "auto-approve", target);
  }

  send(): Promise<DecidedOutcome<Pick<ToolCallApprovalDecisionDto, "approved" | "reason">>> {
    return Promise.resolve(ChannelOutcome.decided({ approved: true }));
  }
}

/** Rejects every call at once (`ChannelOutcome.decided`): no pause — for tests and scripts. */
@Channel({
  name: "auto-reject-channel",
  description: "Automatically rejects any request (for tests)",
})
export class AutoRejectChannel {
  declare readonly [agbossComponent]?: { readonly name: "auto-reject-channel" };

  /** This channel in the place of a role's (or a pause target's) own: a `services` entry of a test. */
  static for(target: Class): new () => AutoRejectChannel {
    return channelFor(AutoRejectChannel, "auto-reject", target);
  }

  send(): Promise<DecidedOutcome<Pick<ToolCallApprovalDecisionDto, "approved" | "reason">>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: false, reason: "rejected automatically" }),
    );
  }
}

/** A channel of its own for a target: the built-in one, named for the target, serving it as `injectAs`. */
function channelFor<TChannel extends { send(): Promise<unknown> }>(
  base: new () => TChannel,
  prefix: string,
  target: Class,
): new () => TChannel {
  const served = class extends base {};
  Channel({
    name: `${prefix}-channel-for-${target.name}`,
    description: `Decides for ${target.name} at once (for tests)`,
  })(served);
  recordInjectAs(served, target);
  return served;
}
