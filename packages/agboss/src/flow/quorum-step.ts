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
  type JoinStep,
  type LaunchStep,
  type QuorumGroup,
  type Step,
  type SubPath,
} from "./ast.js";
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
      message: ".joinQuorumGroups({ deadline }) — min / max do not apply to groups",
    });
  return deadlineOf(options, ".joinQuorumGroups");
}

/** `.joinQuorumGroups({ deadline })` (#1284): the join of a launch whose groups follow as `.onGroup(…)`s. */
export function groupsQuorumOf(options: unknown): GroupsQuorum {
  if (options !== undefined && (typeof options !== "object" || options === null))
    throw new FlowSyntaxError({
      message:
        ".joinQuorumGroups(…) takes its options as an object: .joinQuorumGroups({ deadline })",
    });
  const deadline = groupsDeadlineOf(options ?? {});
  return Object.freeze({
    kind: QuorumKind.Groups,
    groups: Object.freeze([]),
    ...(deadline === undefined ? {} : { deadline }),
  });
}

/** `{ priority }` of `.onGroup(…)`: 1 is the highest. */
export function priorityOf(options: unknown): number | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null)
    throw new FlowSyntaxError({
      message: ".onGroup([targets], options, subPath) takes its options as an object: { priority }",
    });
  const priority: unknown = Reflect.get(options, "priority");
  if (priority === undefined) return undefined;
  if (!isPositiveInteger(priority))
    throw new FlowSyntaxError({
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
    throw new FlowSyntaxError({
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
    throw new FlowSyntaxError({
      message: ".onGroup(…) stands right after .joinQuorumGroups(…) or another .onGroup(…)",
    });
  if (given < 1 || given > 2)
    throw new FlowSyntaxError({
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
