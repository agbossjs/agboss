import { weekReaches } from "../calendar/working-week.js";
import { spanText } from "../units/working-time.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import type { Class } from "../components/injection.js";
import { createdClassesOf } from "../components/injection.js";
import type { ProviderModule } from "../components/container/registrations.js";
import { workingCalendarViolations } from "../calendar/calendar-source.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isWorkingDuration } from "../units/index.js";
import { channelRoleOf } from "./channel-role.decorator.js";
import { rolesOf, type ChannelUse } from "./discovery.js";
import type { FoundChannelRole } from "./channel-role.decorator.js";

/**
 * The assembly rules of working time (#944): a calendar for every working duration
 * (`[channel.working-time-without-calendar]`), a reminder in working time only before a deadline in
 * working time (`[channel.remind-before-working-without-working-expiry]` — a calendar only adds; on
 * the role and on every override site), and a role's own calendar that can work
 * (`[working-calendar.invalid]`).
 */

const listedIn = (modules: readonly ProviderModule[]): readonly Class[] =>
  modules.flatMap((module) => createdClassesOf(module.providers));

/** `[channel.remind-before-working-without-working-expiry]` for a deadline `expiresIn` at `site`, plain while the reminder is working. */
function plainDeadlineViolation(site: string, role: string): RuleViolation {
  return violation(
    "channel.remind-before-working-without-working-expiry",
    `${site}: expiresIn is plain time but ${role}'s remindBefore is working time — a calendar cannot subtract: give expiresIn in workingHours / workingMinutes, or remindBefore in plain time`,
    [site],
  );
}

/** Whether a role's own times are in working time, and it has no calendar anywhere (#944). */
function lacksCalendar(
  options: FoundChannelRole["options"],
  defaultCalendar: WorkingCalendarSource | undefined,
): boolean {
  const isWorking = isWorkingDuration(options.expiresIn) || isWorkingDuration(options.remindBefore);
  return isWorking && options.workingCalendar === undefined && defaultCalendar === undefined;
}

/** The rules of the roles: their reminders, their calendars, their working durations. */
function roleViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  defaultCalendar: WorkingCalendarSource | undefined,
): RuleViolation[] {
  const listed = listedIn(modules);
  return rolesOf(uses).flatMap(({ options }) => {
    const { name, expiresIn, remindBefore, workingCalendar } = options;
    const isPlainDeadline = expiresIn !== undefined && !isWorkingDuration(expiresIn);
    return [
      ...workingCalendarViolations(name, workingCalendar, listed),
      ...(isWorkingDuration(remindBefore) && isPlainDeadline
        ? [plainDeadlineViolation(name, name)]
        : []),
      ...(lacksCalendar(options, defaultCalendar) ? [withoutCalendar(name, name)] : []),
      ...reachViolations(name, [expiresIn, remindBefore], workingCalendar ?? defaultCalendar),
    ];
  });
}

const withoutCalendar = (site: string, role: string): RuleViolation =>
  violation(
    "channel.working-time-without-calendar",
    `${site}: working time needs a calendar, but ${role} has none and the application sets no workingCalendar — set @Application({ workingCalendar }) or @ChannelRole({ workingCalendar })`,
    [site],
  );

/** Whether a use's role (or the application) has a calendar for it. */
const hasCalendarFor = (
  role: FoundChannelRole["options"] | undefined,
  byDefault: WorkingCalendarSource | undefined,
): boolean => role?.workingCalendar !== undefined || byDefault !== undefined;

/**
 * `[working-calendar.invalid]` for a working span a grid cannot reach within 25 years (a sparse
 * grid, a long span): refused at start, never walked. A class calendar is checked at each call.
 */
function reachViolations(
  site: string,
  spans: readonly unknown[],
  source: WorkingCalendarSource | undefined,
): RuleViolation[] {
  return spans.flatMap((span) =>
    isWorkingDuration(span) &&
    // Stryker disable next-line ConditionalExpression: equivalent: with no calendar there is no grid to reach, so `weekReaches` is true for it and nothing is refused; the check says what the rule is
    source !== undefined &&
    // a class calendar is no grid (checked at each call): `weekReaches` is true for it, so it is left out here
    !(source instanceof Function) &&
    !weekReaches(source, span)
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

/** The rules of one tool's or question step's own `expiresIn` over its role's (or a concrete channel's). */
function overrideOf(
  use: ChannelUse,
  defaultCalendar: WorkingCalendarSource | undefined,
): RuleViolation[] {
  const { expiresIn } = use;
  if (expiresIn === undefined) return [];
  const role = channelRoleOf(use.channel)?.options;
  const roleName = role?.name ?? use.tool;
  const found: RuleViolation[] = [];
  if (isWorkingDuration(role?.remindBefore) && !isWorkingDuration(expiresIn))
    found.push(plainDeadlineViolation(use.tool, roleName));
  if (isWorkingDuration(expiresIn) && !hasCalendarFor(role, defaultCalendar))
    found.push(withoutCalendar(use.tool, roleName));
  return found;
}

/** The reach rule of one use's own `expiresIn`. */
const overrideReachOf = (
  use: ChannelUse,
  defaultCalendar: WorkingCalendarSource | undefined,
): RuleViolation[] =>
  reachViolations(
    use.tool,
    [use.expiresIn],
    channelRoleOf(use.channel)?.options.workingCalendar ?? defaultCalendar,
  );

/** `[channel.working-time-without-calendar]`, `[channel.remind-before-working-without-working-expiry]`, `[working-calendar.invalid]` of a workflow's channels. */
export function workingTimeViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  defaultCalendar: WorkingCalendarSource | undefined,
): RuleViolation[] {
  return [
    ...roleViolations(uses, modules, defaultCalendar),
    ...uses.flatMap((use) => overrideOf(use, defaultCalendar)),
    ...uses.flatMap((use) => overrideReachOf(use, defaultCalendar)),
  ];
}
