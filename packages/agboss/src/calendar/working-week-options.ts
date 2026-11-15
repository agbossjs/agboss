import { isTimeZone, localEpochOf, type LocalDate } from "./time-zones.js";

/**
 * The options of `WorkingWeek.of`, checked (#944, `[working-calendar.invalid]`): an unknown time zone,
 * no days, an interval with `from ≥ to` or overlapping another, a break outside `hours`, a malformed
 * holiday, or no working minute left in a week once the breaks are taken out. Every problem is kept,
 * never thrown: the assembly reports them with the application's.
 */

/** Minutes of the local day, `[from, to)`. */
export interface Minutes {
  readonly from: number;
  readonly to: number;
}

const DAY_MINUTES = 1440;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const read = (object: unknown, key: string): unknown =>
  typeof object === "object" && object !== null ? Reflect.get(object, key) : undefined;

/** `"09:30"` → 570; `"24:00"` → 1440 where `isEnd`; `undefined` when it is no time. */
function minutesOf(text: unknown, isEnd: boolean): number | undefined {
  if (typeof text !== "string") return undefined;
  if (isEnd && text === "24:00") return DAY_MINUTES;
  const found = TIME.exec(text);
  return found === null ? undefined : Number(found[1]) * 60 + Number(found[2]);
}

/** One interval as minutes, or why it is none. */
function intervalOf(label: string, entry: unknown): Minutes | string {
  const from = minutesOf(read(entry, "from"), false);
  const to = minutesOf(read(entry, "to"), true);
  const shown = `${label} ${JSON.stringify(entry)}`;
  if (from === undefined || to === undefined)
    return `${shown} needs "from" ("00:00"–"23:59") and "to" ("00:01"–"24:00")`;
  return from >= to ? `${shown} ends before it starts: from must be before to` : { from, to };
}

/** The intervals as minutes, sorted, and the problems of the ones that are not. */
function parsed(label: string, intervals: unknown, problems: string[]): readonly Minutes[] {
  if (!Array.isArray(intervals)) {
    problems.push(`${label} is a list of { from, to } intervals`);
    return [];
  }
  const found: Minutes[] = [];
  for (const entry of intervals as readonly unknown[]) {
    const one = intervalOf(label, entry);
    if (typeof one === "string") problems.push(one);
    else found.push(one);
  }
  return found.sort((left, right) => left.from - right.from);
}

/** The problem of overlapping intervals (sorted), if any. */
function overlapProblem(label: string, sorted: readonly Minutes[]): string | undefined {
  const at = sorted.findIndex(
    (after, index) => index > 0 && after.from < (sorted[index - 1]?.to ?? 0),
  );
  const [before, after] = [sorted[at - 1], sorted[at]];
  if (before === undefined || after === undefined) return undefined;
  return `${label} overlap: ${String(before.from)}–${String(before.to)} and ${String(after.from)}–${String(after.to)} (minutes of the day)`;
}

/** `hours` without `breaks`: the local intervals that are working time, sorted and disjoint. */
export function minusBreaks(
  hours: readonly Minutes[],
  breaks: readonly Minutes[],
): readonly Minutes[] {
  let left: Minutes[] = [...hours];
  for (const cut of breaks) {
    left = left.flatMap((one) => {
      if (cut.to <= one.from || cut.from >= one.to) return [one];
      return [
        ...(cut.from > one.from ? [{ from: one.from, to: cut.from }] : []),
        ...(cut.to < one.to ? [{ from: cut.to, to: one.to }] : []),
      ];
    });
  }
  return left;
}

/** The local date a `"2026-12-25"` names; `undefined` when it is no real date. */
function localDateOf(text: unknown): LocalDate | undefined {
  const found = typeof text === "string" ? LOCAL_DATE.exec(text) : null;
  if (found === null) return undefined;
  const date = { year: Number(found[1]), month: Number(found[2]), day: Number(found[3]) };
  const back = new Date(localEpochOf(date));
  const isReal =
    back.getUTCFullYear() === date.year &&
    back.getUTCMonth() + 1 === date.month &&
    back.getUTCDate() === date.day;
  return isReal ? date : undefined;
}

/** The key of a local date, as a holiday is written: `2026-12-25`. */
export const keyOf = ({ year, month, day }: LocalDate): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const isWeekday = (day: unknown): boolean =>
  typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6;

/** The problems of the zone and the days. */
function whenProblems(options: unknown): string[] {
  const zone = read(options, "timeZone");
  const days = read(options, "days");
  const isDays =
    Array.isArray(days) && days.length > 0 && (days as readonly unknown[]).every(isWeekday);
  return [
    ...(isTimeZone(zone) ? [] : [`timeZone ${JSON.stringify(zone)} is no IANA time zone`]),
    ...(isDays ? [] : ["days is a non-empty list of Weekday values"]),
  ];
}

/** The problems of the holidays. */
function holidayProblems(holidays: unknown): string[] {
  if (holidays === undefined) return [];
  if (!Array.isArray(holidays)) return ["holidays is a list of local dates, like 2026-12-25"];
  return (holidays as readonly unknown[])
    .filter((holiday) => localDateOf(holiday) === undefined)
    .map((holiday) => `holiday ${JSON.stringify(holiday)} is no local date like 2026-12-25`);
}

/** The problems of the hours and breaks; the working intervals they leave. */
function intervalProblems(options: unknown, problems: string[]): readonly Minutes[] {
  const hours = parsed("hours", read(options, "hours"), problems);
  const breakList = read(options, "breaks");
  const breaks = breakList === undefined ? [] : parsed("breaks", breakList, problems);
  for (const [label, list] of [
    ["hours", hours],
    ["breaks", breaks],
  ] as const) {
    const overlap = overlapProblem(label, list);
    if (overlap !== undefined) problems.push(overlap);
  }
  for (const cut of breaks) {
    if (minusBreaks([cut], hours).length > 0)
      problems.push(
        `a break ${String(cut.from)}–${String(cut.to)} (minutes of the day) is not inside the hours`,
      );
  }
  return minusBreaks(hours, breaks);
}

/** The problems of the options; none → the working intervals they leave. */
export function checkedWeek(options: unknown): { problems: string[]; working: readonly Minutes[] } {
  const problems = whenProblems(options);
  const working = intervalProblems(options, problems);
  problems.push(...holidayProblems(read(options, "holidays")));
  if (problems.length === 0 && working.length === 0)
    problems.push("no working minute is left in a week once the breaks are taken out");
  return { problems, working };
}
