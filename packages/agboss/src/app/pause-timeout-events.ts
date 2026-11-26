import { definedFields } from "../core/defined-fields.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import type { ChannelSenderTimeoutChanged } from "../channels/channel-sender.js";
import type { ChannelListenerTimeoutChangedEvent } from "../pause/notice-events.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import { askedOf, changedDeadlinesOf, maskedActor } from "./pause-notice-shape.js";
import { listenerBaseOf, type EventSources } from "./pause-notices.js";

/** What a channel and a listener are told of a timeout change (#942, #1307): split from `pause-notices.ts`. */

/** Who changed the deadline and why: the newest `timeout-changed` entry of the chain of custody, its reason masked when written (#1307). */
function changedByOf(pause: PauseRecord): { actor?: PauseActor; reason?: string } {
  const entry = pause.trail.findLast((one) => one.action === "timeout-changed");
  return definedFields({ actor: entry?.actor, reason: entry?.reason });
}

/** The `timeout-changed` event of a channel (#942). */
export function channelTimeoutChangedOf(sources: EventSources): ChannelSenderTimeoutChanged {
  const { pause, notice, deliveryId } = sources;
  return {
    deliveryId,
    pauseId: pause.pauseId,
    ...askedOf(pause),
    ...changedDeadlinesOf(notice),
    ...changedByOf(pause),
  };
}

/** The `timeout-changed` event of a listener (#942). */
export async function listenerTimeoutChangedOf(
  sources: EventSources,
  includePauseIds: boolean,
): Promise<ChannelListenerTimeoutChangedEvent> {
  const base = await listenerBaseOf(sources, includePauseIds);
  const { notice, pause } = sources;
  const { actor, reason } = changedByOf(pause);
  return {
    ...base,
    ...changedDeadlinesOf(notice),
    ...definedFields({
      reason,
      actor: actor === undefined ? undefined : await maskedActor(sources, actor),
    }),
  };
}
