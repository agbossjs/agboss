import { AGBossError } from "../core/errors.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { Milliseconds } from "../units/index.js";

/**
 * The working calendar (#944): what turns "now + N working time" into a date. Built in: the weekly
 * grid `WorkingWeek.of(…)` (`working-week.ts`); custom: a `@WorkingCalendar` class that sees the
 * tenant and the role and may read the application's own data (a holiday table). The deadline is
 * computed once, when the pause opens; a calendar changed later does not move open pauses.
 */

/** What a calendar is asked: the working time to add to a start, for whom. */
export interface WorkingTimeRequest {
  /** The pause's `askedAt` (an extension: now), on the application's `Clock`. */
  readonly from: Date;
  /** Working time to add. */
  readonly amount: Milliseconds;
  readonly tenantId: string;
  /** The pause's channel name: a role's, or a concrete channel's. */
  readonly channel: string;
}

/** What a `@WorkingCalendar` class implements, and what `WorkingWeek.of(…)` gives. */
export interface WorkingCalendarHandler {
  /** The instant `amount` of working time after `from`. Must be after `from`. */
  addWorkingTime(request: WorkingTimeRequest): Date | Promise<Date>;
}

/** `@WorkingCalendar` options. */
export interface WorkingCalendarOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-working-calendar` (`tenant-holidays-working-calendar`). */
  readonly name: string;
  readonly description?: string;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
}

/** What `@WorkingCalendar` records about a class. */
export interface WorkingCalendarMeta {
  readonly name: string;
  readonly description?: string;
  readonly deps: readonly Token[];
}

/**
 * `@WorkingCalendar({ name, deps? })` on a class that `implements WorkingCalendarHandler`: listed in
 * `@Application({ providers })`, named by `@Application({ workingCalendar })` or a role's
 * `workingCalendar`; created by the application's container at start, one instance.
 */
export function WorkingCalendar<const TDeps extends readonly Token[] = []>(
  options: WorkingCalendarOptions<TDeps>,
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => WorkingCalendarHandler>(
    value: TClass,
  ): TClass => {
    const { name, description } = options;
    const meta = { name, deps: options.deps ?? [] };
    recordComponent(value, {
      kind: "working-calendar",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** What `@WorkingCalendar` recorded on a class; `undefined` when it is not a calendar. */
export function workingCalendarOf(cls: Class): WorkingCalendarMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "working-calendar" ? component.meta : undefined;
}

/** A calendar as an application or a role names it: a grid, or a `@WorkingCalendar` class. */
export type WorkingCalendarSource = WorkingCalendarHandler | Class<WorkingCalendarHandler>;

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
  /** It took longer than the tool timeout. */
  CalendarTimeout = "calendar-timeout",
  /** It answered something that is no valid `Date`. */
  NotADate = "not-a-date",
  /** It answered a date that is not after `from`. */
  NotAfterStart = "not-after-start",
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
