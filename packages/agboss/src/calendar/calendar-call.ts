import { callInFrame, NoticeTimeoutError } from "../app/pause-notice-call.js";
import type { FrameSpec } from "../flow/context/frame.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import {
  DEFAULT_CALENDAR_TIMEOUT,
  isWorkingCalendarHandler,
  isWorkingScheduleResolver,
  WorkingCalendarError,
  WorkingCalendarProblem,
  type WorkingCalendarContext,
  type WorkingCalendarHandler,
} from "./working-calendar.js";
import { isWorkingWeek, workingTimeBefore, workingWeekProblemsOf } from "./working-week.js";

/**
 * One question to a pause's calendar (#944): "the instant `amount` of working time after `from`",
 * asked in the frame of the pause's execution (its `ExecutionContext`: tenant, fields) under the
 * calendar's own timeout on the application's clock. A calendar that resolves a schedule
 * (`resolveSchedule`) is asked for it first, and the core walks it. An answer that is not a valid
 * `Date` after `from`, a schedule that is no valid `WorkingWeek`, a throw and a timeout are
 * `WorkingCalendarError`s — never a fallback to the wall clock, a deadline nobody asked for, silently.
 */

/** A pause's calendar, by the name its errors give. */
export interface PauseCalendar {
  readonly name: string;
  readonly handler: WorkingCalendarHandler;
  /** How long one question may take; `sec(30)` when left out. */
  readonly timeout?: Milliseconds | undefined;
}

/** Whom the calendar is asked for, and where it runs. */
export interface CalendarSite {
  readonly calendar: PauseCalendar | undefined;
  readonly tenantId: string;
  /** The pause's target (or channel) name: what a calendar sees as `target`; none for a quorum's deadline (#1306). */
  readonly role?: string | undefined;
  /** Whom the pause is assigned to: what a dynamic calendar resolves its schedule for. */
  readonly assignees?: readonly string[] | undefined;
  readonly frame: FrameSpec;
  readonly clock: Clock;
  /** The instance's or the run's stop: a calendar cut off by it is no calendar failure. */
  readonly interruption?: AbortSignal | undefined;
  readonly log?: FrameworkLog | undefined;
}

/** A schedule a `resolveSchedule` gave that cannot be walked. */
class InvalidScheduleError extends Error {}

/** The calendar that does the arithmetic: the handler itself, or the schedule it resolves for the request. */
async function walkerOf(
  handler: WorkingCalendarHandler,
  request: WorkingCalendarContext,
): Promise<WorkingCalendarHandler> {
  if (!isWorkingScheduleResolver(handler)) return handler;
  const schedule: unknown = await handler.resolveSchedule(request);
  if (!isWorkingCalendarHandler(schedule) || workingWeekProblemsOf(schedule).length > 0)
    throw new InvalidScheduleError();
  return schedule;
}

/** The request a calendar is asked: the site's tenant, target and assignees. */
const requestOf = (
  site: CalendarSite,
  from: Date,
  amount: WorkingDuration,
): WorkingCalendarContext => ({
  from: new Date(from),
  amount,
  tenantId: site.tenantId,
  ...(site.role === undefined ? {} : { target: site.role }),
  ...(site.assignees === undefined ? {} : { assignees: site.assignees }),
});

/** Runs `ask` in the site's frame under the calendar's timeout, any failure as a `WorkingCalendarError`. */
async function asked<T>(
  site: CalendarSite,
  calendar: PauseCalendar,
  ask: () => Promise<T> | T,
): Promise<T> {
  try {
    return await callInFrame(
      {
        frame: site.frame,
        timeout: calendar.timeout ?? DEFAULT_CALENDAR_TIMEOUT,
        clock: site.clock,
        interruption: site.interruption,
      },
      async () => ask(),
    );
  } catch (error) {
    // the stop of the instance or of the run is not the calendar's failure
    if (site.interruption?.aborted === true) throw error;
    throw failed(
      site,
      calendar,
      error instanceof InvalidScheduleError
        ? WorkingCalendarProblem.InvalidSchedule
        : error instanceof NoticeTimeoutError
          ? WorkingCalendarProblem.CalendarTimeout
          : WorkingCalendarProblem.CalendarFailed,
      error,
    );
  }
}

function failed(
  site: CalendarSite,
  calendar: PauseCalendar,
  problem: WorkingCalendarProblem,
  cause?: unknown,
): WorkingCalendarError {
  const error = new WorkingCalendarError({ calendar: calendar.name, problem, cause });
  site.log?.warn("pause.working-calendar-failed", error.message, {
    tenantId: site.tenantId,
    executionId: site.frame.execution.executionId,
  });
  return error;
}

/** The site's calendar; a working duration reaches a pause without one only past the assembly's rule. */
function calendarOf(site: CalendarSite): PauseCalendar {
  if (site.calendar === undefined)
    throw new TypeError(
      `${site.role === undefined ? "a quorum" : `channel ${site.role}`}: working time without a calendar`,
    );
  return site.calendar;
}

/** `amount` of working time after `from` by the site's calendar, or the `WorkingCalendarError` it fails with. */
export async function workingTimeAfter(
  site: CalendarSite,
  from: Date,
  amount: WorkingDuration,
): Promise<Date> {
  const calendar = calendarOf(site);
  const request = requestOf(site, from, amount);
  const answer: unknown = await asked(site, calendar, async () =>
    (await walkerOf(calendar.handler, request)).addWorkingTime(request),
  );
  if (!(answer instanceof Date) || Number.isNaN(answer.getTime()))
    throw failed(site, calendar, WorkingCalendarProblem.NotADate);
  if (answer.getTime() <= from.getTime())
    throw failed(site, calendar, WorkingCalendarProblem.NotAfterStart);
  return new Date(answer);
}

/** What a reminder is placed from. */
export interface ReminderSpan {
  /** When the pause was asked (or extended). */
  readonly at: Date;
  /** The deadline, after the run's or the quorum's bound clamped it. */
  readonly expiresAt: Date;
  readonly expiresIn: WorkingDuration;
  readonly remindBefore: WorkingDuration;
}

/**
 * Where the reminder of a working-time deadline falls (#1310b), kept only strictly between `at` and
 * `expiresAt`. On a `WorkingWeek`-backed calendar (`week`, `resolveSchedule`, `anyOf`) it is walked
 * **backwards** `remindBefore` along the resolved schedule from the (clamped) deadline, so a
 * deadline a bound pulled in never leaves the reminder past it. A calendar of the project's own
 * can only add: the reminder is `addWorkingTime(at, expiresIn − remindBefore)`, and the two spans
 * must count in the same unit (`WorkingCalendarProblem.MixedUnits` otherwise).
 */
export async function workingReminderAt(
  site: CalendarSite,
  span: ReminderSpan,
): Promise<Date | undefined> {
  const { at, expiresAt, expiresIn, remindBefore } = span;
  const calendar = calendarOf(site);
  const request = requestOf(site, at, expiresIn);
  const walker = await asked(site, calendar, () => walkerOf(calendar.handler, request));
  const found = isWorkingWeek(walker)
    ? await asked(site, calendar, () => workingTimeBefore(walker, expiresAt, remindBefore))
    : await forwardReminder(site, calendar, walker, span);
  return found !== undefined && found.getTime() > at.getTime() && found < expiresAt
    ? found
    : undefined;
}

/** The reminder of a calendar that can only add: `expiresIn − remindBefore` after `at`; none when not positive. */
async function forwardReminder(
  site: CalendarSite,
  calendar: PauseCalendar,
  walker: WorkingCalendarHandler,
  { at, expiresIn, remindBefore }: ReminderSpan,
): Promise<Date | undefined> {
  if (expiresIn.unit !== remindBefore.unit)
    throw failed(site, calendar, WorkingCalendarProblem.MixedUnits);
  const lead = expiresIn.amount - remindBefore.amount;
  if (lead <= 0) return undefined;
  const request = requestOf(site, at, { ...expiresIn, amount: lead });
  const answer: unknown = await asked(site, calendar, () => walker.addWorkingTime(request));
  if (!(answer instanceof Date) || Number.isNaN(answer.getTime()))
    throw failed(site, calendar, WorkingCalendarProblem.NotADate);
  if (answer.getTime() <= at.getTime())
    throw failed(site, calendar, WorkingCalendarProblem.NotAfterStart);
  return answer;
}
