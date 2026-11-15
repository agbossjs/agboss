import type { WorkingCalendarHandler, WorkingTimeRequest } from "./working-calendar.js";
import { checkedWeek, keyOf, type Minutes } from "./working-week-options.js";
import { addDays, localDateAt, localEpochOf, offsetWindows, type LocalDate } from "./time-zones.js";

/**
 * The built-in working calendar (#944): a weekly grid in one time zone — working days, hours,
 * breaks and holidays. **Pointwise rule** (V3.5.1): an instant is working time when its local
 * wall-clock time in `timeZone`, on its local date, lies in some `hours` interval `[from, to)` and
 * in no `breaks` interval, and its local date is a working day and not a holiday. Working time
 * between two instants is the real elapsed time of the working instants between them — so a DST gap
 * inside hours simply has no instants, a fall-back overlap counts both occurrences of a local
 * minute, a break never grows and no interval is counted twice.
 *
 * Per local date the working set is computed as UTC segments — the stretches of constant offset
 * around the date, each local interval mapped into it — merged into a strictly increasing list of
 * disjoint segments; `add` walks them.
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

/** A local wall-clock interval, `"09:00"` – `"18:00"`. */
export interface ClockInterval {
  readonly from: string;
  readonly to: string;
}

/** What `WorkingWeek.of` takes. */
export interface WorkingWeekOptions {
  /** IANA, checked with `Intl`: `Asia/Jerusalem`. */
  readonly timeZone: string;
  readonly days: readonly Weekday[];
  /** Local intervals `[from, to)`, `from < to`, none overlapping; `to` may be `"24:00"`, the end of the date. */
  readonly hours: readonly ClockInterval[];
  /** Local intervals inside `hours` that are not working time. */
  readonly breaks?: readonly ClockInterval[];
  /** Local dates, `"2026-12-25"`, that are not working days. */
  readonly holidays?: readonly string[];
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Every offset of every zone lies within ±14 h: the local date's UTC instants are within this of its local epoch. */
const MAX_OFFSET = 15 * HOUR;

/** Why a grid is invalid, by calendar: read by the assembly (`[working-calendar.invalid]`). */
const problemsOf = new WeakMap<object, readonly string[]>();

/** The problems of a `WorkingWeek.of(…)` grid (`[working-calendar.invalid]`); none for any other calendar. */
export const workingWeekProblemsOf = (calendar: object): readonly string[] =>
  problemsOf.get(calendar) ?? [];

/** The name an error of the built-in grid gives. */
export const WORKING_WEEK_NAME = "working-week";

/** The grids `WorkingWeek.of` made: told from a calendar of the project's own. */
const grids = new WeakSet<object>();

/** Whether a calendar is a grid `WorkingWeek.of` made. */
export const isWorkingWeek = (calendar: object): boolean => grids.has(calendar);

/** The longest walk, in calendar days, whatever the grid: 25 years (plus the holidays). */
export const ABSOLUTE_DAY_LIMIT = 25 * 366;

/** The working minutes a week of each grid has (a validated grid has at least one). */
const weekly = new WeakMap<object, number>();

/** How many holidays and working days a week each grid has (#1148): a holiday costs the walk up to 1 / days of a week. */
const holidayShare = new WeakMap<object, { readonly holidays: number; readonly days: number }>();

/**
 * Whether a grid can give `amount` ms of working time within `ABSOLUTE_DAY_LIMIT` calendar days —
 * estimated in O(1) from its weekly working minutes and its holidays: each holiday removes at most
 * one working day, a `1 / days` share of a week, and the walk needs that much more (#1148: a count
 * that never lets through what the walk would refuse; a holiday on a day the grid does not work
 * still counts, so it can refuse earlier than the walk would fail). True for any calendar that is
 * no grid (a custom calendar is checked at each call).
 *
 * The start of the walk is the day before `from` and the first week is partial, but the walk's
 * limit leaves that room: the estimate and the limit agree to the day, so a span that passes here
 * is reached, and the limit itself stays as the walk's last line (never a loop).
 */
export function weekReaches(calendar: object, amount: number): boolean {
  const minutes = weekly.get(calendar);
  const share = holidayShare.get(calendar);
  if (minutes === undefined || minutes === 0 || share === undefined) return true;
  const weeks = Math.ceil(amount / (minutes * MINUTE)) + Math.ceil(share.holidays / share.days);
  return weeks * 7 <= ABSOLUTE_DAY_LIMIT;
}

/** The amount of working time asked is a positive finite number. */
function assertPositiveFinite(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new RangeError("the amount of working time is a positive finite number");
}

class WorkingWeekCalendar implements WorkingCalendarHandler {
  readonly #zone: string;
  readonly #days: ReadonlySet<number>;
  readonly #holidays: ReadonlySet<string>;
  readonly #working: readonly Minutes[];
  readonly #idleLimit: number;
  readonly #dayLimit: number;

  constructor(
    options: WorkingWeekOptions,
    private readonly estimates = true,
  ) {
    const { problems, working } = checkedWeek(options);
    problemsOf.set(this, problems);
    grids.add(this);
    this.#zone = problems.length === 0 ? options.timeZone : "UTC";
    this.#days = new Set(problems.length === 0 ? options.days : []);
    this.#holidays = new Set(problems.length === 0 ? (options.holidays ?? []) : []);
    this.#working = problems.length === 0 ? working : [];
    // a validated grid has working time in every week: the weeks a holiday list can empty are finitely many
    // (a grid that failed validation has none: its walk ends here, never in the day limit)
    this.#idleLimit = (this.#holidays.size + 1) * 7 + 8;
    // the walk's last line: an absolute number of calendar days, whatever the grid's density
    this.#dayLimit = ABSOLUTE_DAY_LIMIT + this.#holidays.size;
    holidayShare.set(this, { holidays: this.#holidays.size, days: Math.max(1, this.#days.size) });
    weekly.set(
      this,
      this.#days.size * this.#working.reduce((sum, one) => sum + one.to - one.from, 0),
    );
  }

  /** The disjoint UTC segments of the working time of a local date, ascending. */
  #segmentsOf(date: LocalDate): readonly (readonly [number, number])[] {
    const epoch = localEpochOf(date);
    if (!this.#days.has(new Date(epoch).getUTCDay()) || this.#holidays.has(keyOf(date))) return [];
    const found: [number, number][] = [];
    for (const window of offsetWindows(
      this.#zone,
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

  #assertWithinLimit(walked: number): void {
    if (walked > this.#dayLimit)
      throw new RangeError("the amount of working time reaches past the calendar's day limit");
  }

  #assertNotIdle(idle: number): void {
    if (idle > this.#idleLimit)
      throw new RangeError("the working week has no working time ahead of the start");
  }

  addWorkingTime(request: WorkingTimeRequest): Date {
    const start = request.from.getTime();
    let remaining: number = request.amount;
    assertPositiveFinite(remaining);
    if (this.estimates && !weekReaches(this, remaining))
      throw new RangeError(
        "the amount of working time is more than this calendar reaches in 25 years",
      );
    // the date before the start's too: no segment of it ends after the start, but none is missed
    let date = addDays(localDateAt(this.#zone, start), -1);
    let pool: (readonly [number, number])[] = [];
    let idle = 0;
    // the whole walk is bounded, not only its idle stretches: a huge amount fails fast
    for (let walked = 0; ; walked += 1) {
      this.#assertWithinLimit(walked);
      const segments = this.#segmentsOf(date);
      idle = segments.length === 0 ? idle + 1 : 0;
      this.#assertNotIdle(idle);
      pool = [...pool, ...segments].sort((left, right) => left[0] - right[0]);
      date = addDays(date, 1);
      // no later date has an instant before this: what starts earlier is final, in order
      const final = localEpochOf(date) - MAX_OFFSET;
      while (pool[0] !== undefined && pool[0][0] < final) {
        const [from, to] = pool.shift() ?? [0, 0];
        const at = Math.max(from, start);
        if (to <= at) continue;
        if (remaining <= to - at) return new Date(Math.ceil(at + remaining));
        remaining -= to - at;
      }
    }
  }
}

/** Sorted, with the segments that touch or overlap joined: strictly increasing and disjoint. */
function merged(
  segments: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const sorted = [...segments].sort((left, right) => left[0] - right[0]);
  const joined: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = joined[joined.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

/**
 * A grid whose walk is not pre-checked by the O(1) estimate — only for the tests of the walk's own
 * guards (the day limit, the stall guard), which the estimate otherwise pre-empts (#1148).
 *
 * @internal
 */
export const unestimatedWorkingWeek = (options: WorkingWeekOptions): WorkingCalendarHandler =>
  new WorkingWeekCalendar(options, false);

/** The built-in working calendar: a weekly grid in a time zone. */
export const WorkingWeek: { of(options: WorkingWeekOptions): WorkingCalendarHandler } = {
  of: (options) => new WorkingWeekCalendar(options),
};
