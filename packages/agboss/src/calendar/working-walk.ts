import { addDays, localDateAt, localEpochOf, type LocalDate } from "./time-zones.js";
import { merged, type Grid, type Segment } from "./working-grid.js";

/**
 * The walks of the built-in working calendar (#944, #1310): the instant a stretch of working time
 * after (or before) an instant, over one grid or several that work in parallel. **Pointwise rule**:
 * working time between two instants is the real elapsed time of their working instants — a DST gap
 * has no instants, a fall-back overlap counts both occurrences of a local minute, no interval is
 * counted twice. Walking backwards is walking forwards in mirrored time (`walk = −real`), so one
 * walk serves both; a result is rounded up in walk time, so a deadline never comes earlier than the
 * schedule allows and a reminder never later.
 */

/** 1 = towards the future, −1 = towards the past. */
export type Direction = 1 | -1;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Every offset of every zone lies within ±14 h: the local date's UTC instants are within this of its local epoch. */
export const MAX_OFFSET = 15 * HOUR;
/** Rounding noise in a share of a day, far below the 1 / (a day's milliseconds) that tells two shares apart. */
const SHARE_EPSILON = 1e-9;

const NO_WORK = "the working week has no working time ahead of the start";
const PAST_LIMIT = "the amount of working time reaches past the calendar's day limit";

const lengthOf = (segments: readonly Segment[]): number =>
  segments.reduce((sum, [from, to]) => sum + (to - from), 0);

/** A segment in walk time. */
const inWalkTime = ([start, end]: Segment, direction: Direction): Segment =>
  direction === 1 ? [start, end] : [-end, -start];

/** A grid's segments in walk time, one local date at a time, in the walk's direction. */
class Feed {
  #date: LocalDate;

  constructor(
    private readonly grid: Grid,
    private readonly direction: Direction,
    from: number,
  ) {
    // the date before (after, walking back) the start's too: no segment of it reaches past the start, but none is missed
    this.#date = addDays(localDateAt(grid.zone, from), -direction);
  }

  /** The segments, in walk time, of every date that may hold an instant before `until`, not taken before. */
  upTo(until: number): Segment[] {
    const found: Segment[] = [];
    for (;;) {
      const epoch = localEpochOf(this.#date);
      const lowest = this.direction === 1 ? epoch - MAX_OFFSET : -(epoch + DAY + MAX_OFFSET);
      if (lowest >= until) return found;
      for (const segment of this.grid.segmentsOf(this.#date))
        found.push(inWalkTime(segment, this.direction));
      this.#date = addDays(this.#date, this.direction);
    }
  }
}

/** The instant after `need` of the segments' length, from their start. */
function advanced(segments: readonly Segment[], need: number): number {
  let left = need;
  for (const [from, to] of segments) {
    if (left <= to - from) return from + left;
    left -= to - from;
  }
  return segments[segments.length - 1]?.[1] ?? 0;
}

/**
 * The instant `amount` working milliseconds after (before) `from`, counting the instants where any
 * of the grids works once. A day at a time: every segment that starts before the day's end is by
 * then fed in, so the union of the pool over the day is exact.
 */
export function walkMilliseconds(
  grids: readonly Grid[],
  from: number,
  amount: number,
  direction: Direction,
): number {
  if (grids.length === 0) throw new RangeError(NO_WORK);
  const dayLimit = Math.max(...grids.map((grid) => grid.dayLimit));
  const idleLimit = Math.max(...grids.map((grid) => grid.idleLimit));
  const feeds = grids.map((grid) => new Feed(grid, direction, from));
  const startAt = direction * from;
  let remaining = amount;
  let cursor = startAt;
  let pool: readonly Segment[] = [];
  let idle = 0;
  for (let step = 1; ; step += 1) {
    if (step - 1 > dayLimit) throw new RangeError(PAST_LIMIT);
    const until = startAt + step * DAY;
    const union = merged([...pool, ...feeds.flatMap((feed) => feed.upTo(until))]);
    let isWorked = false;
    for (const [begin, finish] of union) {
      const at = Math.max(begin, cursor);
      const end = Math.min(finish, until);
      if (end <= at) continue;
      isWorked = true;
      if (remaining <= end - at) return direction * Math.ceil(at + remaining);
      remaining -= end - at;
    }
    cursor = until;
    pool = union.filter(([, finish]) => finish > until);
    idle = isWorked ? 0 : idle + 1;
    if (idle > idleLimit) throw new RangeError(NO_WORK);
  }
}

/** The live part of a date's segments (in walk time): from `startAt` on. */
const liveFrom = (segments: readonly Segment[], startAt: number): readonly Segment[] =>
  segments.flatMap(([begin, finish]) =>
    finish > startAt ? [[Math.max(begin, startAt), finish] as const] : [],
  );

/**
 * The instant `amount` working days after (before) `from` on one grid. A working day is one local
 * date with working time `D > 0` — however long its shifts; a date with none (a weekend, a holiday)
 * is not counted. A start in the middle of a day counts the rest of that day in proportion
 * (`rest / D`); the last, partial day advances `ceil(share * D)` working milliseconds within it.
 */
export function walkDays(grid: Grid, from: number, amount: number, direction: Direction): number {
  const startAt = direction * from;
  let date = addDays(localDateAt(grid.zone, from), -direction);
  let remaining = amount;
  let idle = 0;
  for (let walked = 0; ; walked += 1) {
    if (walked > grid.dayLimit) throw new RangeError(PAST_LIMIT);
    const segments = grid
      .segmentsOf(date)
      .map((segment) => inWalkTime(segment, direction))
      .sort((left, right) => left[0] - right[0]);
    date = addDays(date, direction);
    const total = lengthOf(segments);
    idle = total === 0 ? idle + 1 : 0;
    if (idle > grid.idleLimit) throw new RangeError(NO_WORK);
    if (total === 0) continue;
    const live = liveFrom(segments, startAt);
    const rest = lengthOf(live);
    const share = rest / total;
    if (remaining > share + SHARE_EPSILON) {
      remaining -= share;
      continue;
    }
    const need = Math.min(rest, Math.max(1, Math.ceil(remaining * total - 1e-6)));
    return direction * advanced(live, need);
  }
}
