import type { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import type { PermitAnswer } from "../../channels/pause-contexts.js";
import type { ChannelSender } from "../../channels/channel-sender.js";
import type { PauseCalendar } from "../../calendar/calendar-call.js";
import type { Milliseconds, WorkingDuration } from "../../units/index.js";

/** A channel as a pause asks it: its sender and who may answer its pauses. */
export interface PauseChannel {
  readonly name: string;
  /** `undefined` for an owner's pause with no channel (#1307c): nobody is asked, it waits for the resume. */
  readonly sender?: ChannelSender | undefined;
  readonly answerer: PauseAnswerer;
  /** The target's `permitAnswer` (#1307c): anything but `true` refuses an answer; `undefined`: none. */
  readonly permitAnswer?: PermitAnswer | undefined;
  /** How long its pauses wait for an answer (#941): its role's `expiresIn`; none → no deadline of its own. */
  readonly expiresIn?: Milliseconds | WorkingDuration | undefined;
  /** How long before its deadline its pauses are reminded (#942): its role's `remindBefore`; none → no reminder. */
  readonly remindBefore?: Milliseconds | WorkingDuration | undefined;
  /** The calendar that counts its working time (#944): its role's, else the application's; none → no working time. */
  readonly calendar?: PauseCalendar | undefined;
}
