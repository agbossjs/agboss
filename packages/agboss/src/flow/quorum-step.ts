import { ConfigError } from "../core/error-families/config-errors.js";
import { MAX_DEADLINE, timerProblemOf } from "../units/timer-limits.js";
import type { Class } from "../components/injection.js";
import { isWorkingDuration, type Milliseconds, type WorkingDuration } from "../units/index.js";
import { MAX_SPAN_DAYS, MAX_SPAN_MS, spanText, type TimeSpan } from "../units/working-time.js";
import {
  QuorumKind,
  StepKind,
  type ArbiterClass,
  type CountQuorum,
  type ForEachItemStep,
  type GroupsQuorum,
  type InParallelStep,
  type JoinStep,
  type QuorumGroup,
  type Step,
  type SubPath,
} from "./ast.js";
import { isLaunching } from "./launch-step.js";

/**
 * The quorum steps of the path builder (#279), read from their arguments: `.arbitratedBy(A)` right
 * after a launch (#1282), `.joinQuorum({ min, max, deadline })` and `.joinQuorumGroups(group(…)…, {
 * deadline })` after it — and the order they impose: an `.arbitratedBy(…)` is followed by a quorum
 * join, never by `.join()`. The typed builder makes the wrong forms compile errors; these checks hold
 * for untyped code.
 */

/** The `@Arbiter` class of `.arbitratedBy(A)`: one per launch (no `anyOf`, no `and` / `or` trees). */
export function arbitratedByOf(arbiter: unknown): ArbiterClass {
  if (typeof arbiter === "function") return arbiter as ArbiterClass;
  throw new ConfigError.FlowSyntax({
    message:
      ".arbitratedBy(…) takes one @Arbiter class — the rule it decides by lives in that class",
  });
}

/** The launch `.arbitratedBy(…)` extends: right after a launch that gives answers a quorum counts. */
export function arbitratingLaunch(previous: Step | undefined): InParallelStep | ForEachItemStep {
  if (!isLaunching(previous))
    throw new ConfigError.FlowSyntax({
      message:
        ".arbitratedBy(…) stands right after .inParallel([…]) or .forEachItem(…), before .joinQuorum(…) / .joinQuorumGroups(…)",
    });
  if (previous.arbitratedBy !== undefined)
    throw new ConfigError.FlowSyntax({
      message: ".arbitratedBy(…) is written once per launch — one @Arbiter class decides it",
    });
  return previous;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** What a quorum's `{ deadline, calendar }` come to: a plain or working duration, and the calendar that counts a working one. */
interface QuorumTime {
  readonly deadline?: TimeSpan;
  readonly calendar?: Class;
}

/** A working deadline's length: positive (the constructor guarantees it) and within the longest a deadline may be. */
function workingProblemOf(deadline: WorkingDuration): string | undefined {
  const largest = deadline.unit === "days" ? MAX_SPAN_DAYS : MAX_SPAN_MS;
  return deadline.amount > largest
    ? `deadline is ${spanText(deadline)}, above its largest of ${String(largest)} ${deadline.unit === "days" ? "working days" : "ms of working time"}`
    : undefined;
}

/** A plain deadline: a positive duration within the timer's cap. */
function plainDeadlineOf(deadline: unknown, call: string): Milliseconds {
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)
    throw new ConfigError.FlowSyntax({
      message: `${call}({ deadline }) takes a positive duration: seconds(30), minutes(2), hours(1), workDays(5)`,
    });
  const tooLong = timerProblemOf("deadline", deadline, MAX_DEADLINE);
  if (tooLong !== undefined)
    throw new ConfigError.FlowSyntax({ message: `${call}({ deadline }): ${tooLong}` });
  return deadline as Milliseconds;
}

/** A working deadline, within its largest. */
function workingDeadlineOf(deadline: WorkingDuration, call: string): WorkingDuration {
  const problem = workingProblemOf(deadline);
  if (problem !== undefined)
    throw new ConfigError.FlowSyntax({ message: `${call}({ deadline }): ${problem}` });
  return deadline;
}

/**
 * `{ deadline, calendar }`: a positive duration (`seconds(30)`, `minutes(2)`, `hours(1)`), or working
 * time (`workDays(5)`) with the `@WorkingCalendar` class that counts it (#1306). A working deadline
 * without `calendar` passes here and fails assembly (`[calendar.required-for-working-duration]`);
 * a `calendar` beside a plain deadline, or none, is a mistake of its own.
 */
function quorumTimeOf(options: object, call: string): QuorumTime {
  const deadline: unknown = Reflect.get(options, "deadline");
  const calendar: unknown = Reflect.get(options, "calendar");
  if (calendar !== undefined && typeof calendar !== "function")
    throw new ConfigError.FlowSyntax({
      message: `${call}({ calendar }) takes a @WorkingCalendar class`,
    });
  const named = calendar === undefined ? {} : { calendar: calendar as Class };
  if (isWorkingDuration(deadline)) return { deadline: workingDeadlineOf(deadline, call), ...named };
  if (calendar !== undefined)
    throw new ConfigError.FlowSyntax({
      message: `${call}({ calendar }) counts working time: give deadline as workDays(…), workHours(…) or workMin(…), or leave calendar out`,
    });
  return deadline === undefined ? {} : { deadline: plainDeadlineOf(deadline, call) };
}

/** `.joinQuorum({ min, max, deadline })`: options are always an object (AC11). */
export function countQuorumOf(options: unknown): CountQuorum {
  if (typeof options !== "object" || options === null)
    throw new ConfigError.FlowSyntax({
      message:
        ".joinQuorum(…) takes its options as an object: .joinQuorum({ min: 2 }), not .joinQuorum(2)",
    });
  const min: unknown = Reflect.get(options, "min");
  const max: unknown = Reflect.get(options, "max");
  if (!isPositiveInteger(min))
    throw new ConfigError.FlowSyntax({ message: ".joinQuorum({ min }) takes a positive integer" });
  if (max !== undefined && (!isPositiveInteger(max) || max < min))
    throw new ConfigError.FlowSyntax({
      message: ".joinQuorum({ min, max }) takes an integer max of at least min",
    });
  return Object.freeze({
    kind: QuorumKind.Count,
    min,
    ...(max === undefined ? {} : { max }),
    ...quorumTimeOf(options, ".joinQuorum"),
  });
}

/** `{ deadline, calendar }` of `.joinQuorumGroups(…)`: `min` / `max` do not apply to groups. */
function groupsTimeOf(options: object): QuorumTime {
  if (Reflect.has(options, "min") || Reflect.has(options, "max"))
    throw new ConfigError.FlowSyntax({
      message: ".joinQuorumGroups({ deadline }) — min / max do not apply to groups",
    });
  return quorumTimeOf(options, ".joinQuorumGroups");
}

/** `.joinQuorumGroups({ deadline })` (#1284): the join of a launch whose groups follow as `.onGroup(…)`s. */
export function groupsQuorumOf(options: unknown): GroupsQuorum {
  if (options !== undefined && (typeof options !== "object" || options === null))
    throw new ConfigError.FlowSyntax({
      message:
        ".joinQuorumGroups(…) takes its options as an object: .joinQuorumGroups({ deadline })",
    });
  return Object.freeze({
    kind: QuorumKind.Groups,
    groups: Object.freeze([]),
    ...groupsTimeOf(options ?? {}),
  });
}

/** `{ priority }` of `.onGroup(…)`: 1 is the highest. */
export function priorityOf(options: unknown): number | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null)
    throw new ConfigError.FlowSyntax({
      message: ".onGroup([targets], options, subPath) takes its options as an object: { priority }",
    });
  const priority: unknown = Reflect.get(options, "priority");
  if (priority === undefined) return undefined;
  if (!isPositiveInteger(priority))
    throw new ConfigError.FlowSyntax({
      message: ".onGroup([…], { priority }, …) takes a positive integer — 1 is the highest",
    });
  return priority;
}

/** One `.onGroup([A, B], { priority }, subPath)`: its targets (one or more classes of the launch), priority and own path. */
export function quorumGroupOf(targets: unknown, options: unknown, path: SubPath): QuorumGroup {
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.some((target) => typeof target !== "function")
  )
    throw new ConfigError.FlowSyntax({
      message:
        ".onGroup([…], …) takes one or more classes of the launch: .onGroup([LegalAgent, CriticAgent], …)",
    });
  const priority = priorityOf(options);
  const group = { targets: Object.freeze([...(targets as readonly Class[])]), path };
  return Object.freeze(priority === undefined ? group : { ...group, priority });
}

/** The groups' join `.onGroup(…)` extends: the last step must be a `.joinQuorumGroups(…)`, with `given` arguments after the targets. */
export function groupsJoinOf(
  last: Step | undefined,
  given: number,
): JoinStep & { readonly quorum: GroupsQuorum } {
  if (last?.kind !== StepKind.Join || last.quorum?.kind !== QuorumKind.Groups)
    throw new ConfigError.FlowSyntax({
      message: ".onGroup(…) stands right after .joinQuorumGroups(…) or another .onGroup(…)",
    });
  if (given < 1 || given > 2)
    throw new ConfigError.FlowSyntax({
      message: ".onGroup(targets, subPath) or .onGroup(targets, { priority }, subPath)",
    });
  return last as JoinStep & { readonly quorum: GroupsQuorum };
}

/** `join` with one more group. */
export function withGroup(
  join: JoinStep & { readonly quorum: GroupsQuorum },
  group: QuorumGroup,
): JoinStep {
  const quorum = Object.freeze({
    ...join.quorum,
    groups: Object.freeze([...join.quorum.groups, group]),
  });
  return Object.freeze({ ...join, quorum });
}
