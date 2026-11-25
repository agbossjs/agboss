import type { ChannelSender } from "../../src/channels/channel-sender.js";
import type { PermitAnswer, PermitReassign } from "../../src/channels/pause-contexts.js";
import type { PauseCalendar } from "../../src/calendar/calendar-call.js";
import type { PauseTarget } from "../../src/flow/runtime/pause-channel.js";
import type { PauseRespondent } from "../../src/pause/respondent.js";
import type { Milliseconds, WorkingDuration } from "../../src/units/index.js";

/**
 * A pause target with its one channel in one flat object, for the tests of the pause step on its own:
 * the channel is `name`, the target `target` (the channel's name without its `-channel`, as a
 * `-tool-approval`, when left out).
 */
export interface FlatChannel {
  readonly name: string;
  readonly target?: string;
  readonly respondent: PauseRespondent;
  readonly sender: ChannelSender;
  readonly expiresIn?: Milliseconds | WorkingDuration | undefined;
  readonly remindBefore?: Milliseconds | WorkingDuration | undefined;
  readonly calendar?: PauseCalendar | undefined;
  readonly permitAnswer?: PermitAnswer | undefined;
  readonly permitReassign?: PermitReassign | undefined;
}

/** The pause target a flat channel is, its channel carried by its `sender`; no channel without one. */
/** A class that stands for the target and channel classes of a unit test. */
class Anything {
  readonly mark = "anything";
}

export function targetOfChannel(flat: FlatChannel): PauseTarget {
  const name = flat.target ?? `${flat.name.replace(/-channel$/, "")}-tool-approval`;
  const channels = new Map([[flat.name, { name: flat.name, sender: flat.sender, cls: Anything }]]);
  return {
    name,
    cls: Anything,
    kind: "tool-approval",
    respondent: flat.respondent,
    channels,
    timeout: flat.expiresIn,
    remindBefore: flat.remindBefore,
    calendar: flat.calendar,
    permitAnswer: flat.permitAnswer,
    permitReassign: flat.permitReassign,
  };
}
