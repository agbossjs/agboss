import { Channel } from "../components/decorators.js";
import { type Class } from "../components/injection.js";
import { seconds } from "../units/index.js";
import { ChannelOutcome, type DecidedOutcome } from "./channel-outcome.js";
import type { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";

/**
 * What a built-in test channel decides is an approval or a refusal, never corrected arguments — so
 * it fits any `@ToolApproval`: list `AutoApproveChannel.for(RefundToolApproval)` in the
 * application's `channels` (#267 S104, #1328).
 *
 * Approves every call at once (`ChannelOutcome.decided`): no pause, no pause record — for tests and
 * scripts; the decision's `by` is the channel's name. A target's channel is scripted in a test with
 * `mockOf(Channel).send`.
 */
export class AutoApproveChannel {
  /** A channel class of its own that serves `target` (named for it), to list in `@Application({ channels })`. */
  static for(target: Class): new () => AutoApproveChannel {
    return channelFor(AutoApproveChannel, "auto-approve", target);
  }

  send(): Promise<DecidedOutcome<Pick<ToolCallApprovalDecisionDto, "approved" | "reason">>> {
    return Promise.resolve(ChannelOutcome.decided({ approved: true }));
  }
}

/** Rejects every call at once (`ChannelOutcome.decided`): no pause — for tests and scripts. */
export class AutoRejectChannel {
  /** A channel class of its own that serves `target` (named for it), to list in `@Application({ channels })`. */
  static for(target: Class): new () => AutoRejectChannel {
    return channelFor(AutoRejectChannel, "auto-reject", target);
  }

  send(): Promise<DecidedOutcome<Pick<ToolCallApprovalDecisionDto, "approved" | "reason">>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: false, reason: "rejected automatically" }),
    );
  }
}

/** A channel of its own for a target: the built-in one, named for the target, serving it by its `target`. */
function channelFor<TChannel extends { send(): Promise<unknown> }>(
  base: new () => TChannel,
  prefix: string,
  target: Class,
): new () => TChannel {
  const served = class extends base {};
  Channel({
    name: `${prefix}-channel-for-${target.name}`,
    description: `Decides for ${target.name} at once (for tests)`,
    target,
    ttl: seconds(3600),
  })(served);
  return served;
}
