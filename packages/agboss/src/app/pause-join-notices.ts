import type { ChannelSenderJoinFailed } from "../channels/channel-sender.js";
import { copyOf } from "../infrastructure/instants.js";
import type { PauseNotice } from "../infrastructure/pause-notices.js";
import type { ChannelListenerJoinFailedEvent } from "../pause/notice-events.js";
import { listenerBaseOf, type EventSources } from "./pause-notices.js";

/** The `joinFailed` notice's events (#945): split from `pause-notices.ts`. */

/** The launch and the error a `joinFailed` notice names (the store writes both). */
function joinFailureOf(notice: PauseNotice): { launch: string; errorCode: string } {
  if (notice.launch === undefined || notice.errorCode === undefined)
    throw new TypeError("a join-failed notice names its launch and the error's code");
  return { launch: notice.launch, errorCode: notice.errorCode };
}

/** The `joinFailed` event of a channel (#945). */
export function channelJoinFailedOf(sources: EventSources): ChannelSenderJoinFailed {
  const { pause, notice, deliveryId } = sources;
  return {
    deliveryId,
    pauseId: pause.pauseId,
    input: pause.input,
    ...(pause.toolCall === undefined ? {} : { toolCall: pause.toolCall }),
    ...joinFailureOf(notice),
    at: copyOf(notice.writtenAt),
  };
}

/** The `joinFailed` event of a listener (#945). */
export async function listenerJoinFailedOf(
  sources: EventSources,
  includePauseIds: boolean,
): Promise<ChannelListenerJoinFailedEvent> {
  const base = await listenerBaseOf(sources, includePauseIds);
  return { ...base, ...joinFailureOf(sources.notice), at: copyOf(sources.notice.writtenAt) };
}
