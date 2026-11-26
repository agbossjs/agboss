import { definedFields } from "../core/defined-fields.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import type { ChannelSenderTimeoutChanged } from "../channels/channel-sender.js";
import type { ChannelListenerTimeoutChangedEvent } from "../pause/notice-events.js";
import type { PauseNotice } from "../infrastructure/pause-notices.js";
import { askedOf, changedDeadlinesOf, maskedActor } from "./pause-notice-shape.js";
import { listenerBaseOf, type EventSources } from "./pause-notices.js";

/** What a channel and a listener are told of a timeout change (#942, #1307): split from `pause-notices.ts`. */

/** Who changed the deadline and why: what the notice was written with, never the chain's newest entry (a late delivery may follow a later change). */
function changedByOf(notice: PauseNotice): { actor?: PauseActor; reason?: string } {
  return definedFields({ actor: notice.actor, reason: notice.changeReason });
}

/** The `timeout-changed` event of a channel (#942). */
export function channelTimeoutChangedOf(sources: EventSources): ChannelSenderTimeoutChanged {
  const { pause, notice, deliveryId } = sources;
  return {
    deliveryId,
    pauseId: pause.pauseId,
    ...askedOf(pause),
    ...changedDeadlinesOf(notice),
    ...changedByOf(notice),
  };
}

/** The `timeout-changed` event of a listener (#942). */
export async function listenerTimeoutChangedOf(
  sources: EventSources,
  includePauseIds: boolean,
): Promise<ChannelListenerTimeoutChangedEvent> {
  const base = await listenerBaseOf(sources, includePauseIds);
  const { notice } = sources;
  const { actor, reason } = changedByOf(notice);
  return {
    ...base,
    ...changedDeadlinesOf(notice),
    ...definedFields({
      reason,
      actor: actor === undefined ? undefined : await maskedActor(sources, actor),
    }),
  };
}
