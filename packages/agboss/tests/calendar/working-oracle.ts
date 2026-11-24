/**
 * An oracle for the working calendar that shares no code with it (#1310b): a real UTC minute is
 * working time when its middle formats, through `Intl`, to a working local minute. Everything else
 * — the working minutes of a stretch, of a local date, the instant after so many of them — is
 * counted minute by minute from that one predicate.
 */
export interface OracleGrid {
  readonly zone: string;
  readonly days: readonly number[];
  readonly hours: readonly (readonly [number, number])[];
  readonly breaks: readonly (readonly [number, number])[];
  readonly holidays: readonly string[];
}

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Oracle {
  /** Whether the real minute starting at `minuteStart` (a multiple of 60 s) is working time. */
  readonly isWorking: (minuteStart: number) => boolean;
  /** The local date, `2026-03-29`, of the real minute starting at `minuteStart`. */
  readonly dateOf: (minuteStart: number) => string;
}

export function oracleOf(grid: OracleGrid): Oracle {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: grid.zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const read = (minuteStart: number) => {
    const parts = format.formatToParts(new Date(minuteStart + 30_000));
    const part = (type: string): string => parts.find((one) => one.type === type)?.value ?? "";
    return {
      date: `${part("year")}-${part("month")}-${part("day")}`,
      weekday: NAMES.indexOf(part("weekday")),
      local: Number(part("hour")) * 60 + Number(part("minute")),
    };
  };
  const inside = (ranges: OracleGrid["hours"], local: number): boolean =>
    ranges.some(([from, to]) => local >= from && local < to);
  return {
    dateOf: (minuteStart) => read(minuteStart).date,
    isWorking: (minuteStart) => {
      const { date, weekday, local } = read(minuteStart);
      return (
        grid.days.includes(weekday) &&
        !grid.holidays.includes(date) &&
        inside(grid.hours, local) &&
        !inside(grid.breaks, local)
      );
    },
  };
}

/** Working minutes in `[from, to)`, both multiples of a minute. */
export function workingMinutesBetween(oracle: Oracle, from: number, to: number): number {
  let counted = 0;
  for (let minute = from; minute < to; minute += MINUTE) if (oracle.isWorking(minute)) counted += 1;
  return counted;
}

/** The union of several oracles: a minute is working when any of them says so. */
export const unionOf = (oracles: readonly Oracle[]): Oracle => ({
  isWorking: (minute) => oracles.some((one) => one.isWorking(minute)),
  dateOf: (minute) => oracles[0]?.dateOf(minute) ?? "",
});

/**
 * The instant `needMs` working milliseconds after `from` (a whole minute), by the minute scan:
 * the end of the last whole minute when `needMs` is a multiple of a minute, else inside the minute.
 */
export function scanAfter(oracle: Oracle, from: number, needMs: number, limit: number): number {
  let left = needMs;
  for (let minute = from; minute < from + limit; minute += MINUTE) {
    if (!oracle.isWorking(minute)) continue;
    if (left <= MINUTE) return minute + left;
    left -= MINUTE;
  }
  throw new Error("the oracle found no end within its limit");
}

/**
 * `workDays(days)` by the definition, from minute counts: each local date with working minutes `D`
 * counts 1; the start's date counts `rest / D`; the last partial day advances `ceil(share × D)` ms.
 * `limit` bounds the scan, in ms.
 */
export function scanDaysAfter(oracle: Oracle, from: number, days: number, limit: number): number {
  const startMinute = Math.floor(from / MINUTE) * MINUTE;
  const byDate = new Map<string, number[]>();
  for (let minute = startMinute - DAY; minute < startMinute + limit; minute += MINUTE) {
    if (!oracle.isWorking(minute)) continue;
    const date = oracle.dateOf(minute);
    byDate.set(date, [...(byDate.get(date) ?? []), minute]);
  }
  const startDate = oracle.dateOf(startMinute);
  let remaining = days;
  for (const [date, minutes] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (date < startDate) continue;
    const live = minutes.filter((minute) => minute >= startMinute);
    const share = live.length / minutes.length;
    if (remaining > share + 1e-9) {
      remaining -= share;
      continue;
    }
    const need = Math.min(
      live.length * MINUTE,
      Math.max(1, Math.ceil(remaining * minutes.length * MINUTE - 1e-6)),
    );
    let left = need;
    for (const minute of live) {
      if (left <= MINUTE) return minute + left;
      left -= MINUTE;
    }
  }
  throw new Error("the oracle found no end within its limit");
}
