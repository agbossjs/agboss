import { MAX_DEADLINE, timerProblemOf } from "../units/timer-limits.js";
import type { Class } from "../components/injection.js";
import type { Milliseconds } from "../units/index.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type ArbiterClass,
  type CountQuorum,
  type ForEachItemStep,
  type GroupsQuorum,
  type InParallelStep,
  type LaunchStep,
  type QuorumGroup,
  type Step,
} from "./ast.js";
import type { PathStart } from "./path-start.js";
import { FlowSyntaxError, isLaunching } from "./launch-step.js";

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
  throw new FlowSyntaxError({
    message:
      ".arbitratedBy(…) takes one @Arbiter class — the rule it decides by lives in that class",
  });
}

/** The launch `.arbitratedBy(…)` extends: right after a launch that gives answers a quorum counts. */
export function arbitratingLaunch(
  previous: Step | undefined,
): LaunchStep | InParallelStep | ForEachItemStep {
  if (!isLaunching(previous))
    throw new FlowSyntaxError({
      message:
        ".arbitratedBy(…) stands right after .inParallel([…]), .forEachItem(…) or .toParallelAgents(…), before .joinQuorum(…) / .joinQuorumGroups(…)",
    });
  if (previous.kind === StepKind.Launch && previous.targetKind !== NodeKind.Agent)
    throw new FlowSyntaxError({
      message: ".arbitratedBy(…) judges answers — after .inParallel([…]) or .toParallelAgents(…)",
    });
  if (previous.arbitratedBy !== undefined)
    throw new FlowSyntaxError({
      message: ".arbitratedBy(…) is written once per launch — one @Arbiter class decides it",
    });
  return previous;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** `{ deadline }`: a positive duration (`seconds()`, `minutes()`, `hours()`), when given. */
function deadlineOf(options: object, call: string): Milliseconds | undefined {
  const deadline: unknown = Reflect.get(options, "deadline");
  if (deadline === undefined) return undefined;
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)
    throw new FlowSyntaxError({
      message: `${call}({ deadline }) takes a positive duration: seconds(30), minutes(2), hours(1)`,
    });
  const tooLong = timerProblemOf("deadline", deadline, MAX_DEADLINE);
  if (tooLong !== undefined)
    throw new FlowSyntaxError({ message: `${call}({ deadline }): ${tooLong}` });
  return deadline as Milliseconds;
}

/** `.joinQuorum({ min, max, deadline })`: options are always an object (AC11). */
export function countQuorumOf(options: unknown): CountQuorum {
  if (typeof options !== "object" || options === null)
    throw new FlowSyntaxError({
      message:
        ".joinQuorum(…) takes its options as an object: .joinQuorum({ min: 2 }), not .joinQuorum(2)",
    });
  const min: unknown = Reflect.get(options, "min");
  const max: unknown = Reflect.get(options, "max");
  if (!isPositiveInteger(min))
    throw new FlowSyntaxError({ message: ".joinQuorum({ min }) takes a positive integer" });
  if (max !== undefined && (!isPositiveInteger(max) || max < min))
    throw new FlowSyntaxError({
      message: ".joinQuorum({ min, max }) takes an integer max of at least min",
    });
  const deadline = deadlineOf(options, ".joinQuorum");
  return Object.freeze({
    kind: QuorumKind.Count,
    min,
    ...(max === undefined ? {} : { max }),
    ...(deadline === undefined ? {} : { deadline }),
  });
}

/** `{ deadline }` of `.joinQuorumGroups(…)`: `min` / `max` do not apply to groups. */
function groupsDeadlineOf(options: object): Milliseconds | undefined {
  if (Reflect.has(options, "min") || Reflect.has(options, "max"))
    throw new FlowSyntaxError({
      message: ".joinQuorumGroups(…, { deadline }) — min / max do not apply to groups",
    });
  return deadlineOf(options, ".joinQuorumGroups");
}

/** The groups and the options of `.joinQuorumGroups(group(…)…, { deadline })`. */
export function groupsQuorumOf(
  args: readonly unknown[],
  asGroup: (path: unknown) => QuorumGroup | undefined,
): GroupsQuorum {
  const last = args[args.length - 1];
  const group = asGroup(last);
  const options = group === undefined && typeof last === "object" && last !== null ? last : {};
  const paths = group === undefined && args.length > 0 ? args.slice(0, -1) : args;
  const groups = paths.map(asGroup);
  if (groups.length === 0 || groups.some((found) => found === undefined))
    throw new FlowSyntaxError({
      message:
        ".joinQuorumGroups(…) takes group(…) paths, then { deadline } — min / max do not apply to groups",
    });
  const deadline = groupsDeadlineOf(options);
  return Object.freeze({
    kind: QuorumKind.Groups,
    groups: Object.freeze(groups as readonly QuorumGroup[]),
    ...(deadline === undefined ? {} : { deadline }),
  });
}

/** `group(…).priority(n)`: 1 is the highest. */
export function priorityOf(priority: unknown): number {
  if (!isPositiveInteger(priority))
    throw new FlowSyntaxError({
      message: "group(…).priority(n) takes a positive integer — 1 is the highest",
    });
  return priority;
}

/** `group(A, B, …).priority(n)` of `.joinQuorumGroups(…)` (#279). */
export interface GroupStart {
  readonly kind: "group";
  readonly agents: readonly Class[];
  readonly priority?: number;
}

/** A group as `.joinQuorumGroups(…)` keeps it: its agents, priority and own path. */
export function quorumGroupOf(start: GroupStart, steps: readonly Step[]): QuorumGroup {
  const { agents, priority } = start;
  const path = Object.freeze({ steps: Object.freeze([...steps]) });
  const group = { agents, path };
  return Object.freeze(priority === undefined ? group : { ...group, priority });
}

/** `group(…).priority(n)`: the group's start with its priority; written right after `group(…)`. */
export function prioritisedStart(
  start: PathStart,
  steps: readonly Step[],
  priority: unknown,
): PathStart {
  if (start.kind !== "group" || steps.length > 0)
    throw new FlowSyntaxError({ message: ".priority(n) stands right after group(…)" });
  return { ...start, priority: priorityOf(priority) };
}
