import type { WorkingDuration } from "../units/index.js";
import type { LocalDate } from "./time-zones.js";

/**
 * What the walks of the working calendar (`working-walk.ts`) need of a weekly grid, and the records
 * the built-in calendars keep about themselves (their problems, their grids, what they reach).
 */

/** A stretch `[start, end)` of UTC instants, in milliseconds. */
export type Segment = readonly [number, number];

/** One weekly grid: the working time of each of its local dates, and its guards. */
export interface Grid {
  /** The IANA zone whose local dates it works by. */
  readonly zone: string;
  /** The disjoint UTC segments of the working time of a local date, ascending. */
  segmentsOf(date: LocalDate): readonly Segment[];
  /** The most consecutive dates without working time a walk crosses before it gives up. */
  readonly idleLimit: number;
  /** The most calendar days a walk goes. */
  readonly dayLimit: number;
}

/** Sorted, with the segments that touch or overlap joined: strictly increasing and disjoint. */
export function merged(segments: readonly Segment[]): readonly Segment[] {
  const sorted = [...segments].sort((left, right) => left[0] - right[0]);
  const joined: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = joined[joined.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

/** The longest walk, in calendar days, whatever the grid: 25 years (plus the holidays). */
export const ABSOLUTE_DAY_LIMIT = 25 * 366;

/** The name an error of the built-in grid gives. */
export const WORKING_WEEK_NAME = "working-week";

/** Whether a duration of working time is within what a calendar reaches in 25 years (O(1)). */
type Reach = (amount: WorkingDuration) => boolean;

interface CalendarRecord {
  readonly problems: readonly string[];
  readonly grids: readonly Grid[];
  readonly reach: Reach;
}

/** The calendars `WorkingWeek.of` / `WorkingWeek.anyOf` made, with their problems, grids and reach. */
const records = new WeakMap<object, CalendarRecord>();

/** Records a built-in calendar. */
export const recordCalendar = (calendar: object, record: CalendarRecord): void => {
  records.set(calendar, record);
};

/** The problems of a `WorkingWeek.of(…)` / `WorkingWeek.anyOf(…)` calendar (`[working-calendar.invalid]`); none for any other. */
export const workingWeekProblemsOf = (calendar: object): readonly string[] =>
  records.get(calendar)?.problems ?? [];

/** Whether a calendar is one `WorkingWeek.of` / `WorkingWeek.anyOf` made. */
export const isWorkingWeek = (calendar: object): boolean => records.has(calendar);

/** The grids a built-in calendar walks (one for `WorkingWeek.of`, one per schedule for `anyOf`); none for any other calendar. */
export const gridsOfCalendar = (calendar: object): readonly Grid[] =>
  records.get(calendar)?.grids ?? [];

/**
 * Whether a calendar can give `amount` of working time within `ABSOLUTE_DAY_LIMIT` calendar days —
 * estimated in O(1) from its weekly working time and its holidays (#1148): a count that never lets
 * through what the walk would refuse. True for any calendar that is no grid (a custom calendar is
 * checked at each call).
 */
export const weekReaches = (calendar: object, amount: WorkingDuration): boolean =>
  records.get(calendar)?.reach(amount) ?? true;
