import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import { isWorkingDuration } from "../units/index.js";
import { amountOf, MAX_SPAN_MS, spanText, type TimeSpan } from "../units/working-time.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import { channelRoleOf, isQuestionRole } from "./channel-role.decorator.js";
import { replyInterpreterViolations } from "./discovery.js";
import { workingTimeViolations } from "./working-time-rules.js";
import {
  channelNameOf,
  channelUsesOf,
  isChannelRole,
  rolesOf,
  type ChannelUse,
} from "./discovery.js";

/**
 * The assembly rules of channels (#267): a tool's input is the `approves` of its role
 * (`[channel.wrong-tool]`), a role has one implementation among the providers
 * (`[di.missing-implementation]`, `[di.ambiguous-implementation]`), a reply interpreter belongs
 * to one role (`[channel.shared-interpreter]`) and is a valid `@ReplyInterpreter` (#267 PR 3). All
 * violations at once.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The listed classes that extend `role` (the role itself is not its implementation). */
export function implementationsOf(role: Class, modules: readonly ProviderModule[]): Class[] {
  const listed = modules.flatMap((module) =>
    module.providers.flatMap((provider) => (typeof provider === "function" ? [provider] : [])),
  );
  return [...new Set(listed)].filter(
    (cls) => cls !== role && Object.prototype.isPrototypeOf.call(role.prototype, cls.prototype),
  );
}

/**
 * A tool approved through a role must take the role's `approves` DTO; a question role (#659) approves
 * none — it is asked by a flow step, `.toQuestion(Role)`.
 */
function wrongToolViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return uses.flatMap((use) => {
    const found = channelRoleOf(use.channel);
    if (found === undefined || use.isQuestion === true) return [];
    const { options } = found;
    if (!isQuestionRole(options) && options.approves === use.toolInput) return [];
    const why = isQuestionRole(options)
      ? `${options.name} asks a question (ask / answer), it approves no tool — ask it with .toQuestion(${nameOf(found.role)})`
      : `${options.name} approves ${nameOf(options.approves)}`;
    return [
      violation(
        "channel.wrong-tool",
        `tool ${use.tool} (input ${nameOf(use.toolInput)}) names channel ${nameOf(use.channel)}, but ${why} — name a role whose approves is ${nameOf(use.toolInput)}`,
        [use.tool, options.name],
      ),
    ];
  });
}

/** Every role a tool names has exactly one implementation among the providers. */
function implementationViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): RuleViolation[] {
  const roles = [...new Set(uses.map((use) => use.channel))].filter(isChannelRole);
  return roles.flatMap((role) => {
    const found = implementationsOf(role, modules);
    const name = channelNameOf(role);
    if (found.length === 1) return [];
    if (found.length === 0) {
      return [
        violation(
          "di.missing-implementation",
          `channel role ${nameOf(role)} (${name}) has no implementation — list a @Channel class that extends ${nameOf(role)} in @Application({ providers })`,
          [name],
        ),
      ];
    }
    return [
      violation(
        "di.ambiguous-implementation",
        `channel role ${nameOf(role)} (${name}) has ${String(found.length)} implementations: ${found.map(nameOf).join(", ")} — list one (one question to several places is one implementation that sends to each)`,
        [name],
      ),
    ];
  });
}

/** One reply interpreter belongs to one role, so its input and output are exact. */
export function sharedInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const byInterpreter = new Map<Class, string[]>();
  for (const { options } of rolesOf(uses)) {
    if (options.replyInterpreter === undefined) continue;
    const names = byInterpreter.get(options.replyInterpreter) ?? [];
    byInterpreter.set(options.replyInterpreter, [...names, options.name]);
  }
  return [...byInterpreter].flatMap(([interpreter, roles]) =>
    roles.length < 2
      ? []
      : [
          violation(
            "channel.shared-interpreter",
            `reply interpreter ${nameOf(interpreter)} is used by ${roles.join(" and ")} — an interpreter belongs to one role; give each role its own`,
            roles,
          ),
        ],
  );
}

/** The shortest deadline a pause may have (#941). */
const MIN_EXPIRES_IN_MS = 1000;

/** `14400000 ms`, or `7200000 ms of working time`. */
const msOf = (span: unknown): string =>
  isWorkingDuration(span) ? spanText(span) : `${String(span)} ms`;

/** Whether `value` is a finite amount of milliseconds in `[min, MAX_SPAN_MS]`, plain or working (#944). */
const isSpanBetween = (value: unknown, min: number): value is TimeSpan => {
  const amount =
    typeof value === "number" ? value : isWorkingDuration(value) ? amountOf(value) : Number.NaN;
  return Number.isFinite(amount) && amount >= min && amount <= MAX_SPAN_MS;
};

/** Whether `value` is a duration of at least `seconds(1)` and at most 5 years: plain, or working time (#944). */
export const isExpiresIn = (value: unknown): value is TimeSpan =>
  isSpanBetween(value, MIN_EXPIRES_IN_MS);

/** `[channel.expires-in-invalid]`: a role's `expiresIn` is a positive finite duration ≥ `seconds(1)`. */
function expiresInViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return rolesOf(uses).flatMap(({ options }) => {
    const { expiresIn } = options;
    if (expiresIn === undefined || isExpiresIn(expiresIn)) return [];
    return [
      violation(
        "channel.expires-in-invalid",
        `channel role ${options.name}: expiresIn is ${spanText(expiresIn)} — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(24)`,
        [options.name],
      ),
    ];
  });
}

/** Whether `value` is a positive finite duration, plain or working (a reminder may be shorter than a deadline may be). */
export const isRemindBefore = (value: unknown): value is TimeSpan =>
  isSpanBetween(value, Number.MIN_VALUE);

/**
 * Whether a reminder is not shorter than the deadline it precedes: plain with plain, working with
 * working (#944) — a plain amount against working time is not comparable here (the wall-clock
 * time working time takes is the calendar's to say), so it is no problem of the role.
 */
export const isNotShorter = (remindBefore: TimeSpan, expiresIn: unknown): boolean =>
  (typeof expiresIn === "number" || isWorkingDuration(expiresIn)) &&
  isWorkingDuration(remindBefore) === isWorkingDuration(expiresIn) &&
  amountOf(remindBefore) >= amountOf(expiresIn as TimeSpan);

/**
 * `[channel.remind-before-invalid]` (#942): a role's `remindBefore` is a positive finite duration,
 * shorter than the role's own `expiresIn` (a reminder at or after the deadline never goes out).
 */
function remindBeforeViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return rolesOf(uses).flatMap(({ options }) => {
    const { remindBefore, expiresIn } = options;
    if (remindBefore === undefined) return [];
    const problem = !isRemindBefore(remindBefore)
      ? `remindBefore is ${spanText(remindBefore)} — a reminder is a positive finite duration of at most 5 years, like hours(2)`
      : isNotShorter(remindBefore, expiresIn)
        ? `remindBefore (${msOf(remindBefore)}) is not shorter than its expiresIn (${msOf(expiresIn)}) — the reminder would go out at or before the pause is asked`
        : undefined;
    if (problem === undefined) return [];
    return [
      violation("channel.remind-before-invalid", `channel role ${options.name}: ${problem}`, [
        options.name,
      ]),
    ];
  });
}

/** The rules of one workflow's channels (its children included) over the providers it sees. */
export function channelRuleViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  defaultCalendar?: WorkingCalendarSource,
): RuleViolation[] {
  return [
    ...wrongToolViolations(uses),
    ...implementationViolations(uses, modules),
    ...replyInterpreterViolations(uses),
    ...expiresInViolations(uses),
    ...remindBeforeViolations(uses),
    ...workingTimeViolations(uses, modules, defaultCalendar),
  ];
}

/**
 * The channels of one workflow (#267), its children's included, checked at its assembly: each
 * tool's input is its role's `approves`, each role has one implementation among the providers; a
 * workflow on its own also one interpreter per role (an application checks that across workflows).
 */
export function checkChannels(
  workflow: Class,
  modules: readonly ProviderModule[],
  isStandalone: boolean,
  defaultCalendar?: WorkingCalendarSource,
): void {
  const uses = channelUsesOf([workflow]);
  const violations = [
    ...channelRuleViolations(uses, modules, defaultCalendar),
    ...(isStandalone ? sharedInterpreterViolations(uses) : []),
  ];
  if (violations.length > 0) throw new GraphRuleError({ violations });
}
