/**
 * Time zones through `Intl` only (#944, no new dependency): the offset of a zone at an instant, its
 * local date, and the stretches of constant offset around a local date — what the working week
 * walks to turn a local wall-clock interval into the real (UTC) instants it covers, DST gaps and
 * overlaps included.
 */

const HOUR = 3_600_000;
const SECOND = 1000;

/** The `Intl` formatters, one per zone. `hourCycle: "h23"`: midnight is hour 0 under every locale (V8's `hour12: false` gives "24"). */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(zone: string): Intl.DateTimeFormat {
  const kept = formatters.get(zone);
  if (kept !== undefined) return kept;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  formatters.set(zone, made);
  return made;
}

/** Whether `Intl` knows the zone, as an IANA name (`Asia/Jerusalem`, `UTC`; not a bare offset). */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "" || /^[+-]/.test(zone)) return false;
  try {
    formatterOf(zone);
    return true;
  } catch {
    return false;
  }
}

/** A local calendar date. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The local calendar fields of an instant in a zone (whole numbers). */
interface LocalFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The local fields of an instant in a zone. */
function fieldsAt(zone: string, instant: number): LocalFields {
  const parts = formatterOf(zone).formatToParts(new Date(instant));
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetAt(zone: string, instant: number): number {
  const whole = Math.floor(instant / SECOND) * SECOND;
  const f = fieldsAt(zone, whole);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - whole;
}

/** The local date of an instant in a zone. */
export function localDateAt(zone: string, instant: number): LocalDate {
  const { year, month, day } = fieldsAt(zone, instant);
  return { year, month, day };
}

/** The first instant of the local date read as if it were UTC: the day's "local epoch". */
export const localEpochOf = ({ year, month, day }: LocalDate): number =>
  Date.UTC(year, month - 1, day);

/** The local date `days` after (or before) `date`. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(localEpochOf(date) + days * 24 * HOUR);
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** A stretch of instants `[start, end)` with one offset. */
export interface OffsetWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

/** The sampling step: no zone changes its offset twice within it. */
const STEP = 3 * HOUR;

/** The instant the offset changes in `(low, high]`, one change known to lie there (to the second). */
function changeBetween(zone: string, low: number, high: number): number {
  const before = offsetAt(zone, low);
  let lo = low;
  let hi = high;
  while (hi - lo > SECOND) {
    const mid = lo + Math.floor((hi - lo) / (2 * SECOND)) * SECOND;
    if (offsetAt(zone, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

const windowCache = new Map<string, readonly OffsetWindow[]>();
const WINDOW_CACHE_LIMIT = 4096;

/** The stretches of constant offset that cover `[from, to)`, in order (their ends clipped to it). */
export function offsetWindows(zone: string, from: number, to: number): readonly OffsetWindow[] {
  const key = `${zone}|${String(from)}|${String(to)}`;
  const kept = windowCache.get(key);
  if (kept !== undefined) return kept;
  const found: OffsetWindow[] = [];
  let start = from;
  let offset = offsetAt(zone, from);
  for (let at = from; at < to; at += STEP) {
    const next = Math.min(at + STEP, to);
    const there = offsetAt(zone, next === to ? to - SECOND : next);
    if (there === offset) continue;
    const change = changeBetween(zone, at, next === to ? to - SECOND : next);
    found.push({ start, end: change, offset });
    start = change;
    offset = there;
  }
  found.push({ start, end: to, offset });
  if (windowCache.size >= WINDOW_CACHE_LIMIT) windowCache.clear();
  windowCache.set(key, found);
  return found;
}
