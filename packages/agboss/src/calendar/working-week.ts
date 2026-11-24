import { isWorkingDuration, type WorkingDuration } from "../units/index.js";
import type { WorkingCalendarContext, WorkingCalendarHandler } from "./working-calendar.js";
import { checkedWeek, keyOf, type Minutes } from "./working-week-options.js";
import { localEpochOf, offsetWindows, type LocalDate } from "./time-zones.js";
import { workingInstant } from "./working-add.js";
import {
  ABSOLUTE_DAY_LIMIT,
  gridsOfCalendar,
  isWorkingWeek,
  merged,
  recordCalendar,
  weekReaches,
  workingWeekProblemsOf,
  WORKING_WEEK_NAME,
  type Grid,
  type Segment,
} from "./working-grid.js";
import { MAX_OFFSET } from "./working-walk.js";

export { ABSOLUTE_DAY_LIMIT, isWorkingWeek, weekReaches, workingWeekProblemsOf, WORKING_WEEK_NAME };

/**
 * The built-in working calendar (#944): a weekly grid in one time zone — working days, hours,
 * breaks and holidays. **Pointwise rule** (V3.5.1): an instant is working time when its local
 * wall-clock time in `timeZone`, on its local date, lies in some `hours` interval `[from, to)` and
 * in no `breaks` interval, and its local date is a working day and not a holiday. Working time
 * between two instants is the real elapsed time of the working instants between them (see
 * `working-walk.ts`). `WorkingWeek.anyOf(…)` merges several such grids — a pool of people in
 * several zones, any of whom may answer.
 */

/** A day of the week, as `Date#getDay` numbers it. */
export enum Weekday {
  Sunday = 0,
  Monday = 1,
  Tuesday = 2,
  Wednesday = 3,
  Thursday = 4,
  Friday = 5,
  Saturday = 6,
}

/** A local wall-clock window, `"09:00"` – `"18:00"`. */
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}

/** What `WorkingWeek.of` takes. */
export interface WorkingWeekOptions {
  /** IANA, checked with `Intl`: `Asia/Jerusalem`. */
  readonly timeZone: string;
  readonly days: readonly Weekday[];
  /** Local windows `[from, to)`, `from < to`, none overlapping; `to` may be `"24:00"`, the end of the date. */
  readonly hours: readonly TimeWindow[];
  /** Local windows inside `hours` that are not working time. */
  readonly breaks?: readonly TimeWindow[];
  /** Local dates, `"2026-12-25"`, that are not working days. */
  readonly holidays?: readonly string[];
  /**
   * Whether a local date, `"2026-12-25"`, is not a working day: a holiday rule that does not go
   * stale with the year (a holiday table, an HR service's answer). Asked once per date a walk crosses;
   * must be synchronous and pure for the date. A calendar whose walk finds no working time in a
   * year (`() => true`) fails with `RangeError`, never loops.
   */
  readonly isHoliday?: (localDate: string) => boolean;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** No working time within this many consecutive days of a start fails the walk: a year (a year's leave is no stall). */
const IDLE_FLOOR = 366;

/** The amount of working time asked is a working duration of positive finite amount. */
function assertDuration(amount: unknown): asserts amount is WorkingDuration {
  if (!isWorkingDuration(amount) || !Number.isFinite(amount.amount) || amount.amount <= 0)
    throw new RangeError("the amount of working time is a positive finite working duration");
}

/** One weekly grid, in one zone. */
class WorkingWeekCalendar implements WorkingCalendarHandler, Grid {
  readonly zone: string;
  readonly idleLimit: number;
  readonly dayLimit: number;
  readonly #days: ReadonlySet<number>;
  readonly #holidays: ReadonlySet<string>;
  readonly #isHoliday: ((localDate: string) => boolean) | undefined;
  readonly #working: readonly Minutes[];

  constructor(
    options: WorkingWeekOptions,
    private readonly estimates = true,
  ) {
    const { problems, working } = checkedWeek(options);
    const isValid = problems.length === 0;
    this.zone = isValid ? options.timeZone : "UTC";
    this.#days = new Set(isValid ? options.days : []);
    this.#holidays = new Set(isValid ? (options.holidays ?? []) : []);
    this.#isHoliday = isValid ? options.isHoliday : undefined;
    this.#working = isValid ? working : [];
    // a validated grid has working time in every week: the weeks a holiday list can empty are finitely many
    // (a grid that failed validation has none: its walk ends here, never in the day limit); a year idle is
    // the most a holiday rule or a long leave may cover
    this.idleLimit = Math.max(IDLE_FLOOR, (this.#holidays.size + 1) * 7 + 8);
    // the walk's last line: an absolute number of calendar days, whatever the grid's density
    this.dayLimit = ABSOLUTE_DAY_LIMIT + this.#holidays.size;
    const weeklyMinutes =
      this.#days.size * this.#working.reduce((sum, one) => sum + one.to - one.from, 0);
    recordCalendar(this, {
      problems,
      grids: [this],
      reach: (amount) => this.#reaches(amount, weeklyMinutes),
    });
  }

  /** The O(1) estimate (#1148): each holiday removes at most one working day, a `1 / days` share of a week. */
  #reaches(amount: WorkingDuration, weeklyMinutes: number): boolean {
    if (weeklyMinutes === 0) return true;
    const days = Math.max(1, this.#days.size);
    const perWeek = amount.unit === "days" ? days : weeklyMinutes * MINUTE;
    const weeks = Math.ceil(amount.amount / perWeek) + Math.ceil(this.#holidays.size / days);
    return weeks * 7 <= ABSOLUTE_DAY_LIMIT;
  }

  /** The disjoint UTC segments of the working time of a local date, ascending. */
  segmentsOf(date: LocalDate): readonly Segment[] {
    const epoch = localEpochOf(date);
    const key = keyOf(date);
    if (!this.#days.has(new Date(epoch).getUTCDay()) || this.#holidays.has(key)) return [];
    if (this.#isHoliday?.(key) === true) return [];
    const found: Segment[] = [];
    for (const window of offsetWindows(
      this.zone,
      epoch - MAX_OFFSET,
      epoch + 24 * HOUR + MAX_OFFSET,
    )) {
      for (const interval of this.#working) {
        const start = Math.max(window.start, epoch + interval.from * MINUTE - window.offset);
        const end = Math.min(window.end, epoch + interval.to * MINUTE - window.offset);
        if (start < end) found.push([start, end]);
      }
    }
    return merged(found);
  }

  addWorkingTime(request: WorkingCalendarContext): Date {
    assertDuration(request.amount);
    if (this.estimates && !weekReaches(this, request.amount))
      throw new RangeError(
        "the amount of working time is more than this calendar reaches in 25 years",
      );
    return new Date(workingInstant([this], request.from.getTime(), request.amount, 1));
  }
}

/** Several grids that work in parallel: a pool of people, any of whom may answer. */
class AnyOfCalendar implements WorkingCalendarHandler {
  constructor(schedules: readonly WorkingCalendarHandler[]) {
    const problems = schedules.flatMap((schedule, index) =>
      isWorkingWeek(schedule)
        ? workingWeekProblemsOf(schedule).map((one) => `schedule ${String(index)}: ${one}`)
        : [`schedule ${String(index)} is no WorkingWeek.of({ … }) or WorkingWeek.anyOf([…])`],
    );
    if (schedules.length === 0) problems.push("anyOf takes at least one schedule");
    const grids = problems.length === 0 ? schedules.flatMap((one) => gridsOfCalendar(one)) : [];
    recordCalendar(this, {
      problems,
      grids,
      reach: (amount) => problems.length > 0 || schedules.some((one) => weekReaches(one, amount)),
    });
  }

  addWorkingTime(request: WorkingCalendarContext): Date {
    assertDuration(request.amount);
    if (!weekReaches(this, request.amount))
      throw new RangeError(
        "the amount of working time is more than this calendar reaches in 25 years",
      );
    return new Date(
      workingInstant(gridsOfCalendar(this), request.from.getTime(), request.amount, 1),
    );
  }
}

/**
 * The instant `amount` of working time **before** `to` on a built-in calendar — where a reminder
 * that is `remindBefore` of working time ahead of a deadline falls; `undefined` for a calendar of
 * the project's own (it can only add). Throws `RangeError` as `addWorkingTime` does.
 */
export function workingTimeBefore(
  calendar: object,
  to: Date,
  amount: WorkingDuration,
): Date | undefined {
  const grids = gridsOfCalendar(calendar);
  if (grids.length === 0) return undefined;
  assertDuration(amount);
  return new Date(workingInstant(grids, to.getTime(), amount, -1));
}

/**
 * A grid whose walk is not pre-checked by the O(1) estimate — only for the tests of the walk's own
 * guards (the day limit, the stall guard), which the estimate otherwise pre-empts (#1148).
 *
 * @internal
 */
export const unestimatedWorkingWeek = (options: WorkingWeekOptions): WorkingCalendarHandler =>
  new WorkingWeekCalendar(options, false);

/** The built-in working calendar: a weekly grid in a time zone, and the union of several. */
export const WorkingWeek: {
  of(options: WorkingWeekOptions): WorkingCalendarHandler;
  anyOf(schedules: readonly WorkingCalendarHandler[]): WorkingCalendarHandler;
} = {
  of: (options) => new WorkingWeekCalendar(options),
  anyOf: (schedules) => new AnyOfCalendar(schedules),
};
