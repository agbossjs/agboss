import { PauseError } from "../core/error-families/pause-errors.js";
import {
  workingReminderAt,
  workingTimeAfter,
  type CalendarSite,
} from "../calendar/calendar-call.js";
import type { FrameSpec } from "../flow/context/frame.js";
import type { AddWorkingTime, RemindAt } from "../flow/runtime/pause-record-made.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { AppDeps } from "./app-deps.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";

/**
 * A pause's calendar as an operator's call or an expiry asks it (#944, #1307): the shared working-time
 * code (`workingTimeAfter`, `workingReminderAt`) of the *destination* target's calendar, in the
 * pause's frame, for the assignees the pause has after the change. The frame is read from the
 * stores only when working time is asked; a target with no calendar is `PauseError.WorkingCalendar`,
 * never the calendar of the target the pause came from.
 */

/** What asking a calendar needs of the application. */
export interface CalendarParts {
  readonly deps: AppDeps;
  readonly clock: Clock;
  readonly interruption?: AbortSignal | undefined;
}

/** `add` and `remind` for `target`, asked for `assignees`, in `pause`'s frame. */
export function calendarOfTarget(
  parts: CalendarParts,
  pause: PauseRecord,
  target: PauseTarget,
  assignees: readonly string[] | undefined,
): { readonly add: AddWorkingTime; readonly remind: RemindAt } {
  const { deps, clock } = parts;
  let framed: Promise<FrameSpec> | undefined;
  const frameOf = async (): Promise<FrameSpec> =>
    pauseFrameOf(
      deps,
      pause,
      await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId)),
    );
  const siteOf = async (): Promise<CalendarSite> => {
    if (target.calendar === undefined)
      throw new PauseError.WorkingCalendar({
        message: `pause target ${target.name} has no working calendar: its timeouts count hours or minutes`,
      });
    framed ??= frameOf();
    return {
      calendar: target.calendar,
      tenantId: pause.tenantId,
      role: target.name,
      assignees,
      frame: await framed,
      clock,
      interruption: parts.interruption,
      log: deps.log,
    };
  };
  return {
    add: async (from, amount) => workingTimeAfter(await siteOf(), from, amount),
    remind: async (span) => workingReminderAt(await siteOf(), span),
  };
}
