import { ConfigError } from "../core/error-families/config-errors.js";
import { isWorkingDuration } from "../units/index.js";
import {
  amountOf,
  MAX_SPAN_MS,
  MAX_SPAN_DAYS,
  unitOf,
  type TimeSpan,
} from "../units/working-time.js";
import type { ComponentOptions } from "../components/component-options.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { isCountLimit, shownLimit } from "../graph/count-limit.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  channelTargetOf,
  isExternalTask,
  listedClassesOf,
  findPauseTarget,
} from "./pause-targets.js";
import { pauseTargetViolations } from "./pause-target-rules.js";
import { replyInterpreterViolations, targetsOfUses } from "./discovery.js";
import { pauseTimingViolations } from "./pause-timing-rules.js";
import { channelUsesOf, type ChannelUse } from "./discovery.js";

/**
 * The assembly rules of pause targets and their channels (#267, #1307): a tool's input is the
 * `input` of its `@ToolApproval` (`[channel.wrong-tool]`), a target has a channel when it needs one
 * (`[channel.missing-for-target]`, `[channel.ambiguous-for-target]`), a channel interpreter belongs
 * to one target (`[channel.shared-interpreter]`) and is a valid `@ChannelInterpreter` (#267 PR 3).
 * All violations at once.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The listed channels that serve `target`: a `@Channel({ target })` names it. */
export function channelsOf(target: Class, modules: readonly ProviderModule[]): Class[] {
  return listedClassesOf(modules).filter((cls) => channelTargetOf(cls) === target);
}

/**
 * A tool approved through a target must take the target's `input` DTO (a target with none approves
 * any tool); an external task approves no tool — it is asked by a flow step, `.toExternalTask(Task)`.
 */
function wrongToolViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return uses.flatMap((use) => {
    const found = findPauseTarget(use.target);
    if (use.isQuestion === true) return [];
    if (found === undefined) {
      return [
        violation(
          "channel.wrong-tool",
          `tool ${use.tool} names ${nameOf(use.target)} as its approval, which is no @ToolApproval — name a @ToolApproval class`,
          [use.tool],
        ),
      ];
    }
    const { options } = found;
    if (
      !isExternalTask(options) &&
      (options.input === undefined || options.input === use.toolInput)
    )
      return [];
    const why = isExternalTask(options)
      ? `${options.name} is an external task, it approves no tool — ask it with .toExternalTask(${nameOf(found.target)})`
      : `${options.name} approves ${nameOf(options.input as Class)}`;
    return [
      violation(
        "channel.wrong-tool",
        `tool ${use.tool} (input ${nameOf(use.toolInput)}) names ${nameOf(use.target)} as its approval, but ${why} — name a @ToolApproval whose input is ${nameOf(use.toolInput)}`,
        [use.tool, options.name],
      ),
    ];
  });
}

/** One channel interpreter belongs to one target, so its input and output are exact. */
export function sharedInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const byInterpreter = new Map<Class, string[]>();
  for (const { options } of targetsOfUses(uses)) {
    if (options.channelInterpreter === undefined) continue;
    const names = byInterpreter.get(options.channelInterpreter) ?? [];
    byInterpreter.set(options.channelInterpreter, [...names, options.name]);
  }
  return [...byInterpreter].flatMap(([interpreter, roles]) =>
    roles.length < 2
      ? []
      : [
          violation(
            "channel.shared-interpreter",
            `channel interpreter ${nameOf(interpreter)} is used by ${roles.join(" and ")} — an interpreter belongs to one target; give each target its own`,
            roles,
          ),
        ],
  );
}

/** The shortest deadline a pause may have (#941). */
const MIN_PAUSE_TIMEOUT_MS = 1000;

/**
 * Whether `value` is a finite amount of milliseconds in `[min, MAX_SPAN_MS]`, plain or working
 * (#944) — or, for `workDays`, a positive number of working days up to `MAX_SPAN_DAYS` (a day count
 * is no millisecond count: `min` does not apply to it).
 */
const isSpanBetween = (value: unknown, min: number): value is TimeSpan => {
  if (isWorkingDuration(value) && value.unit === "days")
    return Number.isFinite(value.amount) && value.amount > 0 && value.amount <= MAX_SPAN_DAYS;
  const amount =
    typeof value === "number" ? value : isWorkingDuration(value) ? amountOf(value) : Number.NaN;
  return Number.isFinite(amount) && amount >= min && amount <= MAX_SPAN_MS;
};

/** Whether `value` is a duration of at least `seconds(1)` and at most 5 years: plain, or working time (#944). */
export const isPauseTimeout = (value: unknown): value is TimeSpan =>
  isSpanBetween(value, MIN_PAUSE_TIMEOUT_MS);

/**
 * `[limits.count-invalid]` (#1373): an external task's `maxVisits`, which also bounds the questions
 * an agent asks through it as a tool, is a whole number from 0; the value is named by its kind only.
 */
function maxVisitsViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return targetsOfUses(uses).flatMap(({ options }) => {
    if (!isExternalTask(options)) return [];
    const { maxVisits } = options;
    if (maxVisits === undefined || isCountLimit(maxVisits)) return [];
    return [
      violation(
        "limits.count-invalid",
        `external task ${options.name}: maxVisits is ${shownLimit(maxVisits)}, not a whole number from 0 — maxVisits: 3 sets it; leave it out for no limit`,
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
 * working of the same unit (#944) — a plain amount against working time, or working days against
 * working hours, is not comparable here (the wall-clock time working time takes is the calendar's
 * to say), so it is no problem of the role.
 */
export const isNotShorter = (remindBefore: TimeSpan, expiresIn: unknown): boolean =>
  (typeof expiresIn === "number" || isWorkingDuration(expiresIn)) &&
  isWorkingDuration(remindBefore) === isWorkingDuration(expiresIn) &&
  unitOf(remindBefore) === unitOf(expiresIn as TimeSpan) &&
  amountOf(remindBefore) >= amountOf(expiresIn as TimeSpan);

/** The rules of one workflow's pause targets (its children's included) over the providers it sees. */
export function channelRuleViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  options: ComponentOptions,
): RuleViolation[] {
  return [
    ...wrongToolViolations(uses),
    ...pauseTargetViolations(uses, modules, options),
    ...replyInterpreterViolations(uses),
    ...maxVisitsViolations(uses),
    ...pauseTimingViolations(uses, modules),
  ];
}

/**
 * The pause targets of one workflow (#267), its children's included, checked at its assembly: each
 * tool's input is its approval's `input`, each target has the channels it needs; a workflow on its
 * own also one interpreter per target (an application checks that across workflows).
 */
export function checkChannels(
  workflow: Class,
  modules: readonly ProviderModule[],
  options: ComponentOptions,
  isStandalone: boolean,
): void {
  const uses = channelUsesOf([workflow]);
  const violations = [
    ...channelRuleViolations(uses, modules, options),
    ...(isStandalone ? sharedInterpreterViolations(uses) : []),
  ];
  if (violations.length > 0) throw new ConfigError.GraphRules({ violations });
}
