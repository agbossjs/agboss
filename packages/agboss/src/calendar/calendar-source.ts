import type { Class } from "../components/injection.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { PauseCalendar } from "./calendar-call.js";
import {
  isWorkingCalendarHandler,
  workingCalendarOf,
  type WorkingCalendarHandler,
  type WorkingCalendarSource,
} from "./working-calendar.js";
import { isWorkingWeek, workingWeekProblemsOf, WORKING_WEEK_NAME } from "./working-week.js";

/**
 * Where a calendar comes from (#944): `@Application({ workingCalendar })` the default,
 * `@ChannelRole({ workingCalendar })` the role's own — a `WorkingWeek.of(…)` grid, or a
 * `@WorkingCalendar` class listed in `providers`, created by the application's container.
 */

const classNameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The name a calendar's errors give: its `@WorkingCalendar` name, `working-week` for a grid. */
export function calendarNameOf(source: WorkingCalendarSource): string {
  if (typeof source === "function") return workingCalendarOf(source)?.name ?? classNameOf(source);
  return isWorkingWeek(source) ? WORKING_WEEK_NAME : "working-calendar";
}

/** The calendar a source is, a class made by `resolve` (the container). */
export function pauseCalendarOf(
  source: WorkingCalendarSource | undefined,
  resolve: (cls: Class) => unknown,
): PauseCalendar | undefined {
  if (source === undefined) return undefined;
  const handler: WorkingCalendarHandler =
    typeof source === "function" ? (resolve(source) as WorkingCalendarHandler) : source;
  return { name: calendarNameOf(source), handler };
}

/** What a class is as a calendar: its problems, none when it is a listed `@WorkingCalendar` handler. */
function classProblems(cls: Class, listed: readonly Class[]): readonly string[] {
  const meta = workingCalendarOf(cls);
  if (meta === undefined)
    return [`${classNameOf(cls)} has no @WorkingCalendar({ name }) decorator`];
  const problems: string[] = [];
  const { prototype } = cls as { prototype: Partial<WorkingCalendarHandler> };
  if (typeof prototype.addWorkingTime !== "function")
    problems.push(
      `${classNameOf(cls)} (@WorkingCalendar "${meta.name}") must implement addWorkingTime(request)`,
    );
  if (!listed.includes(cls))
    problems.push(
      `${classNameOf(cls)} (@WorkingCalendar "${meta.name}") is not listed — add it to @Application({ providers })`,
    );
  return problems;
}

/**
 * `[working-calendar.invalid]` (#944): a calendar given as `owner`'s `workingCalendar` that cannot
 * work — a grid with an unknown time zone, no days, a bad interval, a break outside the hours, a
 * malformed holiday or no working minute in a week; a class that is no listed `@WorkingCalendar`
 * with `addWorkingTime`; anything else. A custom calendar cannot be checked further: it is checked
 * at each call.
 */
export function workingCalendarViolations(
  owner: string,
  source: unknown,
  listed: readonly Class[],
): RuleViolation[] {
  if (source === undefined) return [];
  const problems =
    typeof source === "function"
      ? classProblems(source as Class, listed)
      : isWorkingCalendarHandler(source)
        ? workingWeekProblemsOf(source)
        : ["workingCalendar is neither WorkingWeek.of({ … }) nor a @WorkingCalendar class"];
  return problems.map((problem) =>
    violation("working-calendar.invalid", `${owner}: working calendar: ${problem}`, [owner]),
  );
}

/**
 * The rules of the `@WorkingCalendar` classes an application lists (#944), like a listener's: a name
 * ending `-working-calendar` (`[name.kind-suffix]`) and one class per name
 * (`[working-calendar.duplicate-name]`) — the name is what a `WorkingCalendarError` says.
 */
export function workingCalendarNameViolations(
  application: string,
  listed: readonly Class[],
): RuleViolation[] {
  const byName = new Map<string, Class[]>();
  const found: RuleViolation[] = [];
  for (const cls of new Set(listed)) {
    const name = workingCalendarOf(cls)?.name;
    if (name === undefined) continue;
    byName.set(name, [...(byName.get(name) ?? []), cls]);
    const problem = kindSuffixProblem(name, NameKind.WorkingCalendar);
    if (problem !== undefined) found.push(violation(problem.code, problem.message, [application]));
  }
  for (const [name, classes] of byName) {
    if (classes.length < 2) continue;
    const message = `"${name}" names ${classes.map(classNameOf).join(" and ")} in ${application}'s providers — give each its own name`;
    found.push(violation("working-calendar.duplicate-name", message, [application]));
  }
  return found;
}
