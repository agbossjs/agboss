import { weekReaches } from "../calendar/working-week.js";
import { spanText } from "../units/working-time.js";
import type { Class } from "../components/injection.js";
import { createdClassesOf } from "../components/injection.js";
import type { ProviderModule } from "../components/container/registrations.js";
import { declaredGridOfClass, workingCalendarViolations } from "../calendar/calendar-source.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isWorkingDuration } from "../units/index.js";
import { isNotShorter, isPauseTimeout, isRemindBefore } from "./channel-rules.js";
import { targetsOfUses, type ChannelUse } from "./discovery.js";
import type { PauseTargetOptions } from "./pause-targets.js";

/**
 * The assembly rules of a target's times (#941, #942, #944, #1310): its `timeout` is a duration of
 * at least `seconds(1)` (`[limits.timeout-invalid]`), its `remindBefore` a positive one shorter than
 * it (`[pause.remind-before-invalid]`) and in working time only before a timeout in working time
 * (`[pause.remind-before-working-without-working-timeout]` — a calendar only adds), a working
 * `timeout` or `remindBefore` needs the target's own `calendar`
 * (`[calendar.required-for-working-duration]`) that can work (`[working-calendar.invalid]`).
 */

const listedIn = (modules: readonly ProviderModule[]): readonly Class[] =>
  modules.flatMap((module) => createdClassesOf(module.providers));

/** `14400000 ms`, or `7200000 ms of working time`. */
const msOf = (span: unknown): string =>
  isWorkingDuration(span) ? spanText(span) : `${String(span)} ms`;

const hasHook = (target: Class, hook: string): boolean =>
  typeof Reflect.get(target.prototype as object, hook) === "function";

/** `[limits.timeout-invalid]`, `[pause.remind-before-*]` of one target. */
function timeViolations(target: Class, options: PauseTargetOptions): RuleViolation[] {
  const { name, timeout, remindBefore } = options;
  const found: RuleViolation[] = [];
  if (!isPauseTimeout(timeout))
    found.push(
      violation(
        "limits.timeout-invalid",
        `pause target ${name}: timeout is ${spanText(timeout)} — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(24)`,
        [name],
      ),
    );
  if (remindBefore === undefined) return found;
  const resolves = hasHook(target, "resolveTimeout");
  if (!isRemindBefore(remindBefore))
    found.push(
      violation(
        "pause.remind-before-invalid",
        `pause target ${name}: remindBefore is ${spanText(remindBefore)} — a reminder is a positive finite duration of at most 5 years, like hours(2)`,
        [name],
      ),
    );
  else if (!resolves && isNotShorter(remindBefore, timeout))
    found.push(
      violation(
        "pause.remind-before-invalid",
        `pause target ${name}: remindBefore (${msOf(remindBefore)}) is not shorter than its timeout (${msOf(timeout)}) — the reminder would go out at or before the pause is asked`,
        [name],
      ),
    );
  if (isWorkingDuration(remindBefore) && !isWorkingDuration(timeout))
    found.push(
      violation(
        "pause.remind-before-working-without-working-timeout",
        `pause target ${name}: timeout is plain time but remindBefore is working time — a calendar cannot subtract: give timeout in workMin / workHours / workDays, or remindBefore in plain time`,
        [name],
      ),
    );
  return found;
}

const gridOf = declaredGridOfClass;

/**
 * `[working-calendar.invalid]` for a working span a grid cannot reach within 25 years (a sparse
 * grid, a long span): refused at start, never walked. A class calendar is checked at each call.
 */
function reachViolations(
  site: string,
  spans: readonly unknown[],
  source: Class | undefined,
): RuleViolation[] {
  return spans.flatMap((span) =>
    isWorkingDuration(span) &&
    // a class calendar of its own is checked at each call; a declared week is a grid, checked here
    source !== undefined &&
    gridOf(source) !== undefined &&
    !weekReaches(gridOf(source) as object, span)
      ? [
          violation(
            "working-calendar.invalid",
            `${site}: ${spanText(span)} is more working time than its calendar reaches in 25 years`,
            [site],
          ),
        ]
      : [],
  );
}

/** The rules of the targets' times, calendars and working durations. */
export function pauseTimingViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): RuleViolation[] {
  const listed = listedIn(modules);
  return targetsOfUses(uses).flatMap(({ target, options }) => {
    const { name, timeout, remindBefore, calendar } = options;
    const isWorking = isWorkingDuration(timeout) || isWorkingDuration(remindBefore);
    return [
      ...timeViolations(target, options),
      ...workingCalendarViolations(name, calendar, listed),
      ...(isWorking && calendar === undefined
        ? [
            violation(
              "calendar.required-for-working-duration",
              `pause target ${name}: working time needs a calendar — set calendar on it (a @WorkingCalendar class), or use plain durations (min, hours, days)`,
              [name],
            ),
          ]
        : []),
      ...reachViolations(name, [timeout, remindBefore], calendar),
    ];
  });
}
