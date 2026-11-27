import { definedFields } from "../core/defined-fields.js";
import { copyOfOptional } from "../infrastructure/instants.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ChannelSenderReassigned } from "../channels/channel-sender.js";
import type { ChannelListenerReassignedEvent } from "../pause/notice-events.js";
import { askedOf, maskedActor } from "./pause-notice-shape.js";
import { listenerBaseOf, type EventSources } from "./pause-notices.js";

/** What a channel and a listener are told of a reassignment (#1307d): split from `pause-notices.ts`. */

/** The newest entry of a pause's chain of custody: the reassignment's who and why, as it was masked when written. */
const lastEntryOf = (pause: PauseRecord) => pause.trail.at(-1);

/** The `reassigned` event of a channel that sent the pause and keeps it (#1307d). */
export function channelReassignedOf(sources: EventSources): ChannelSenderReassigned {
  const { pause, notice, deliveryId } = sources;
  const entry = lastEntryOf(pause);
  return {
    deliveryId,
    pauseId: pause.pauseId,
    ...askedOf(pause),
    previousTarget: notice.previousTarget ?? pause.target,
    previousChannel: notice.previousChannel ?? pause.channel ?? "",
    channel: pause.channel ?? "",
    ...definedFields({
      assignees: pause.assignees,
      previousAssignees: notice.previousAssignees,
      externalRef: pause.externalRef,
      expiresAt: copyOfOptional(notice.expiresAt),
      previousExpiresAt: copyOfOptional(notice.previousExpiresAt),
      reason: entry?.reason,
      actor: entry?.actor,
    }),
  };
}

/** The `reassigned` event of a listener (#1307d): one for an in-place change and for a move to another target or channel alike. */
export async function listenerReassignedOf(
  sources: EventSources,
  includePauseIds: boolean,
): Promise<ChannelListenerReassignedEvent> {
  const { notice, pause } = sources;
  const base = await listenerBaseOf(sources, includePauseIds);
  const entry = lastEntryOf(pause);
  const previous = (await sources.masked({
    assignees: notice.previousAssignees,
    externalRef: notice.previousExternalRef,
  })) as { assignees?: readonly string[]; externalRef?: string };
  return {
    ...base,
    previousTarget: notice.previousTarget ?? pause.target,
    ...definedFields({
      previousChannel: notice.previousChannel,
      previousAssignees: previous.assignees,
      previousExternalRef: previous.externalRef,
      previousExpiresAt: copyOfOptional(notice.previousExpiresAt),
      reason: entry?.reason,
      actor: entry?.actor === undefined ? undefined : await maskedActor(sources, entry.actor),
    }),
  };
}
