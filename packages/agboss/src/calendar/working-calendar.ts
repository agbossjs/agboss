import { AGBossError } from "../core/errors.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import { sec, type Milliseconds, type WorkingDuration } from "../units/index.js";
import type { WorkingWeekOptions } from "./working-week.js";

/**
 * The working calendar (#944): what turns "now + N working time" into a date. Built in: the weekly
 * grid `WorkingWeek.of(…)` and the pool `WorkingWeek.anyOf(…)` (`working-week.ts`); custom: a
 * `@WorkingCalendar` class that sees the tenant and the assignees and may read the application's
 * own data (a holiday table, an HR directory) — resolving a schedule for the core to walk, or adding
 * the time itself. The deadline is computed once, when the pause opens; a calendar changed later
 * does not move open pauses.
 */

/** What a calendar is asked: the working time to add to a start, for whom. */
export interface WorkingCalendarContext {
  /** The pause's `askedAt` (an extension: now), on the application's `Clock`. */
  readonly from: Date;
  /**
   * Working time to add: `{ unit: "ms", amount }` working milliseconds (`workMin`, `workHours`) or
   * `{ unit: "days", amount }` working days of the schedule (`workDays`) — a calendar that counts
   * days must count them, never as 24 hours.
   */
  readonly amount: WorkingDuration;
  readonly tenantId: string;
  /** The pause target (`@ToolApproval` / `@ExternalTask`) the deadline is for; none for a quorum's. */
  readonly target?: string;
  /** Whom the pause is assigned to: the schedule of a dynamic calendar is theirs. */
  readonly assignees?: readonly string[];
}

/** What a `@WorkingCalendar` class with its own arithmetic implements, and what `WorkingWeek.of(…)` gives. */
export interface WorkingCalendarHandler {
  /** The instant `amount` of working time after `from`. Must be after `from`. */
  addWorkingTime(request: WorkingCalendarContext): Date | Promise<Date>;
}

/**
 * What a dynamic `@WorkingCalendar` class implements to leave the arithmetic — the DST, the
 * intervals, the working days — to the core: the schedule of whom the pause is for, as a
 * `WorkingWeek.of(…)` / `WorkingWeek.anyOf(…)` (a pool in several zones).
 */
export interface WorkingScheduleResolver {
  resolveSchedule(
    request: WorkingCalendarContext,
  ): WorkingCalendarHandler | Promise<WorkingCalendarHandler>;
}

/** What every `@WorkingCalendar` form takes. */
export interface WorkingCalendarCommon {
  /** Kebab-case; the class name in kebab-case when left out (`TenantHolidays` → `tenant-holidays`). */
  readonly name?: string;
  readonly description?: string;
  /** How long one question to the calendar may take; `sec(30)` when left out. */
  readonly timeout?: Milliseconds;
}

/** `@WorkingCalendar({ week })`: a declarative grid on an empty class. */
export interface DeclarativeWorkingCalendarOptions extends WorkingCalendarCommon {
  readonly week: WorkingWeekOptions;
  readonly deps?: never;
}

/** `@WorkingCalendar({ deps? })`: a class with `resolveSchedule` or `addWorkingTime`. */
export interface DynamicWorkingCalendarOptions<
  TDeps extends readonly Token[] = readonly Token[],
> extends WorkingCalendarCommon {
  readonly week?: never;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
}

/** `@WorkingCalendar` options. */
export type WorkingCalendarOptions<TDeps extends readonly Token[] = readonly Token[]> =
  DeclarativeWorkingCalendarOptions | DynamicWorkingCalendarOptions<TDeps>;

/** What `@WorkingCalendar` records about a class. */
export interface WorkingCalendarMeta {
  readonly name: string;
  readonly description?: string;
  readonly deps: readonly Token[];
  /** The declarative grid of `@WorkingCalendar({ week })`. */
  readonly week?: WorkingWeekOptions;
  readonly timeout: Milliseconds;
}

/** How long a question to a calendar may take when `timeout` is left out. */
export const DEFAULT_CALENDAR_TIMEOUT: Milliseconds = sec(30);

/**
 * `@WorkingCalendar` (#944, #1310): a calendar class, named by a pause target's `calendar`.
 * - `@WorkingCalendar({ week: { … } })` on an empty class: a weekly grid, declared.
 * - `@WorkingCalendar({ deps? })` on a class with `resolveSchedule(ctx)`: the core does the DST and
 *   interval arithmetic over the schedule it returns (per assignee, per region, `WorkingWeek.anyOf`).
 * - `@WorkingCalendar({ deps? })` on a class with `addWorkingTime(ctx)`: the class does all the arithmetic.
 */
export function WorkingCalendar(
  options: DeclarativeWorkingCalendarOptions,
): <TClass extends new () => { resolveSchedule?: never; addWorkingTime?: never }>(
  value: TClass,
) => TClass;
export function WorkingCalendar<const TDeps extends readonly Token[] = []>(
  options: DynamicWorkingCalendarOptions<TDeps>,
): <
  TClass extends new (
    ...args: ResolvedAll<TDeps>
  ) => WorkingCalendarHandler | WorkingScheduleResolver,
>(
  value: TClass,
) => TClass;
export function WorkingCalendar(options: WorkingCalendarOptions) {
  return <TClass extends Class>(value: TClass): TClass => {
    const { description, week } = options;
    const meta = {
      name: resolvedName(options.name, value),
      deps: options.deps ?? [],
      timeout: options.timeout ?? DEFAULT_CALENDAR_TIMEOUT,
      ...(description === undefined ? {} : { description }),
      ...(week === undefined ? {} : { week }),
    };
    recordComponent(value, { kind: "working-calendar", meta });
    return value;
  };
}

/** What `@WorkingCalendar` recorded on a class; `undefined` when it is not a calendar. */
export function workingCalendarOf(cls: Class): WorkingCalendarMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "working-calendar" ? component.meta : undefined;
}

/** A calendar as an application or a pause target names it: a grid, or a `@WorkingCalendar` class. */
export type WorkingCalendarSource = WorkingCalendarHandler | Class;

/** Whether a value resolves its schedule (`resolveSchedule`) rather than doing the arithmetic itself. */
export const isWorkingScheduleResolver = (value: unknown): value is WorkingScheduleResolver =>
  typeof value === "object" &&
  value !== null &&
  "resolveSchedule" in value &&
  typeof value.resolveSchedule === "function";

/** Whether a value has the one function a calendar must have. */
export const isWorkingCalendarHandler = (value: unknown): value is WorkingCalendarHandler =>
  typeof value === "object" &&
  value !== null &&
  "addWorkingTime" in value &&
  typeof value.addWorkingTime === "function";

/** Why a calendar could not give a deadline. */
export enum WorkingCalendarProblem {
  /** It threw. */
  CalendarFailed = "calendar-failed",
  /** It took longer than its timeout. */
  CalendarTimeout = "calendar-timeout",
  /** It answered something that is no valid `Date`. */
  NotADate = "not-a-date",
  /** It answered a date that is not after `from`. */
  NotAfterStart = "not-after-start",
  /** A calendar of the project's own cannot place a reminder in a unit other than its deadline's: it can only add. */
  MixedUnits = "mixed-units",
  /** Its `resolveSchedule` answered no valid schedule: an invalid or empty `WorkingWeek`, or no calendar at all. */
  InvalidSchedule = "invalid-schedule",
}

/** What a `WorkingCalendarError` names. */
export interface WorkingCalendarErrorOptions {
  /** The calendar's name: its `@WorkingCalendar` name, or `working-week` for the built-in grid. */
  readonly calendar: string;
  readonly problem: WorkingCalendarProblem;
  /** What went wrong, only in-process: never in the message (it may hold personal data). */
  readonly cause?: unknown;
}

/**
 * A pause's calendar could not answer (#944): the step that asked failed and nobody was asked —
 * `QuestionFailedError` / `AgentFailedError` with this as its `cause` — or `app.extendPause` was
 * refused and the pause is unchanged. The message never holds the calendar's own error text.
 */
export class WorkingCalendarError extends AGBossError {
  static override readonly code = "pause.working-calendar" as const;
  declare readonly code: typeof WorkingCalendarError.code;
  override name = "WorkingCalendarError";
  readonly calendar: string;
  readonly problem: WorkingCalendarProblem;

  constructor(options: WorkingCalendarErrorOptions) {
    const { calendar, problem, cause } = options;
    super(`working calendar ${calendar}: ${problem}`, {
      cause,
      details: { calendar, problem },
    });
    this.calendar = calendar;
    this.problem = problem;
  }
}
