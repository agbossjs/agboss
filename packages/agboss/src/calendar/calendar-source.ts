import type { Class } from "../components/injection.js";
import { kebabNameProblem } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { PauseCalendar } from "./calendar-call.js";
import {
  DEFAULT_CALENDAR_TIMEOUT,
  isWorkingCalendarHandler,
  workingCalendarOf,
  type WorkingCalendarHandler,
  type WorkingCalendarMeta,
  type WorkingCalendarSource,
} from "./working-calendar.js";
import {
  isWorkingWeek,
  WorkingWeek,
  workingWeekProblemsOf,
  WORKING_WEEK_NAME,
} from "./working-week.js";

/**
 * Where a calendar comes from (#944): `@Application({ workingCalendar })` the default,
 * `@ChannelRole({ workingCalendar })` the role's own — a `WorkingWeek.of(…)` grid, a declarative
 * `@WorkingCalendar({ week })` class, or a `@WorkingCalendar` class listed in `providers`, created
 * by the application's container.
 */

/** The grid of each declarative `@WorkingCalendar({ week })` class, made once. */
const declared = new WeakMap<Class, WorkingCalendarHandler>();

const declaredGridOf = (cls: Class, week: NonNullable<WorkingCalendarMeta["week"]>) => {
  const kept = declared.get(cls);
  if (kept !== undefined) return kept;
  const made = WorkingWeek.of(week);
  declared.set(cls, made);
  return made;
};

/** The grid a declarative `@WorkingCalendar({ week })` class is; `undefined` for any other class. */
export function declaredGridOfClass(cls: Class): WorkingCalendarHandler | undefined {
  const week = workingCalendarOf(cls)?.week;
  return week === undefined ? undefined : declaredGridOf(cls, week);
}

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
  const meta = typeof source === "function" ? workingCalendarOf(source) : undefined;
  const handler: WorkingCalendarHandler =
    typeof source !== "function"
      ? source
      : meta?.week === undefined
        ? (resolve(source) as WorkingCalendarHandler)
        : declaredGridOf(source, meta.week);
  return {
    name: calendarNameOf(source),
    handler,
    timeout: meta?.timeout ?? DEFAULT_CALENDAR_TIMEOUT,
  };
}

/** What a declarative `@WorkingCalendar({ week })` class is: the problems of its grid, and of any arithmetic of its own. */
function declaredProblems(cls: Class, meta: WorkingCalendarMeta): readonly string[] {
  const { prototype } = cls as { prototype: object };
  const own = ["addWorkingTime", "resolveSchedule"].filter(
    (method) => typeof Reflect.get(prototype, method) === "function",
  );
  return [
    ...(meta.week === undefined ? [] : workingWeekProblemsOf(WorkingWeek.of(meta.week))),
    ...own.map(
      (method) =>
        `${classNameOf(cls)} (@WorkingCalendar "${meta.name}") declares a week and has ${method}`,
    ),
  ];
}

/** What a class is as a calendar: its problems, none when it is a valid `@WorkingCalendar`. */
function classProblems(cls: Class, listed: readonly Class[]): readonly string[] {
  const meta = workingCalendarOf(cls);
  if (meta === undefined)
    return [`${classNameOf(cls)} has no @WorkingCalendar({ name }) decorator`];
  // a declared grid is no provider: nothing is created for it
  if (meta.week !== undefined) return declaredProblems(cls, meta);
  const problems: string[] = [];
  const prototype = (cls as { prototype: object }).prototype;
  const [isAdder, isResolver] = ["addWorkingTime", "resolveSchedule"].map(
    (method) => typeof Reflect.get(prototype, method) === "function",
  );
  if (isAdder !== true && isResolver !== true)
    problems.push(
      `${classNameOf(cls)} (@WorkingCalendar "${meta.name}") must implement resolveSchedule(ctx) or addWorkingTime(ctx), or declare a week`,
    );
  if (isAdder === true && isResolver === true)
    problems.push(
      `${classNameOf(cls)} (@WorkingCalendar "${meta.name}") implements both resolveSchedule and addWorkingTime — choose one`,
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
 * malformed holiday or no working minute in a week; a `WorkingWeek.anyOf` of none or of a
 * non-grid; a class that is no listed `@WorkingCalendar` with `resolveSchedule` or `addWorkingTime` (or a
 * declared `week`); anything else. A custom calendar cannot be checked further: it is checked
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
 * that is kebab-case (`[name.not-kebab-case]`) and one class per name
 * (`[working-calendar.duplicate-name]`) — the name is what a `PauseError.WorkingCalendar` says.
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
    const problem = kebabNameProblem(name, "@WorkingCalendar");
    if (problem !== undefined) found.push(violation(problem.code, problem.message, [application]));
  }
  for (const [name, classes] of byName) {
    if (classes.length < 2) continue;
    const message = `"${name}" names ${classes.map(classNameOf).join(" and ")} in ${application}'s providers — give each its own name`;
    found.push(violation("working-calendar.duplicate-name", message, [application]));
  }
  return found;
}
