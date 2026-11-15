import { callInFrame, NoticeTimeoutError } from "../app/pause-notice-call.js";
import type { FrameSpec } from "../flow/context/frame.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { DEFAULT_TOOL_TIMEOUT } from "../tools/index.js";
import type { Milliseconds } from "../units/index.js";
import {
  WorkingCalendarError,
  WorkingCalendarProblem,
  type WorkingCalendarHandler,
} from "./working-calendar.js";

/**
 * One question to a pause's calendar (#944): "the instant `amount` of working time after `from`",
 * asked in the frame of the pause's execution (its `ExecutionContext`: tenant, fields) under the
 * tool timeout on the application's clock. An answer that is not a valid `Date` after `from`, a
 * throw and a timeout are `WorkingCalendarError`s — never a fallback to the wall clock, a
 * deadline nobody asked for, silently.
 */

/** A pause's calendar, by the name its errors give. */
export interface PauseCalendar {
  readonly name: string;
  readonly handler: WorkingCalendarHandler;
}

/** Whom the calendar is asked for, and where it runs. */
export interface CalendarSite {
  readonly calendar: PauseCalendar | undefined;
  readonly tenantId: string;
  /** The pause's channel name. */
  readonly role: string;
  readonly frame: FrameSpec;
  readonly clock: Clock;
  /** The instance's or the run's stop: a calendar cut off by it is no calendar failure. */
  readonly interruption?: AbortSignal | undefined;
  readonly log?: FrameworkLog | undefined;
}

/** `amount` of working time after `from` by the site's calendar, or the `WorkingCalendarError` it fails with. */
export async function workingTimeAfter(
  site: CalendarSite,
  from: Date,
  amount: Milliseconds | number,
): Promise<Date> {
  const { calendar } = site;
  // a working duration reaches a role without a calendar only past the assembly's rule
  if (calendar === undefined)
    throw new TypeError(`channel ${site.role}: working time without a calendar`);
  const fail = (problem: WorkingCalendarProblem, cause?: unknown): WorkingCalendarError => {
    const error = new WorkingCalendarError({ calendar: calendar.name, problem, cause });
    site.log?.warn("pause.working-calendar-failed", error.message, {
      tenantId: site.tenantId,
      executionId: site.frame.execution.executionId,
    });
    return error;
  };
  let answer: unknown;
  try {
    answer = await callInFrame(
      {
        frame: site.frame,
        timeout: DEFAULT_TOOL_TIMEOUT,
        clock: site.clock,
        interruption: site.interruption,
      },
      async () =>
        calendar.handler.addWorkingTime({
          from: new Date(from),
          amount: amount as Milliseconds,
          tenantId: site.tenantId,
          channel: site.role,
        }),
    );
  } catch (error) {
    // the stop of the instance or of the run is not the calendar's failure
    if (site.interruption?.aborted === true) throw error;
    throw fail(
      error instanceof NoticeTimeoutError
        ? WorkingCalendarProblem.CalendarTimeout
        : WorkingCalendarProblem.CalendarFailed,
      error,
    );
  }
  if (!(answer instanceof Date) || Number.isNaN(answer.getTime()))
    throw fail(WorkingCalendarProblem.NotADate);
  if (answer.getTime() <= from.getTime()) throw fail(WorkingCalendarProblem.NotAfterStart);
  return new Date(answer);
}
