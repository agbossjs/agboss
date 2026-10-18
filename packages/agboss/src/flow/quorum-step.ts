import type { Class } from "../components/injection.js";
import type { Milliseconds } from "../units/index.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type AcceptedBy,
  type ArbiterClass,
  type CountQuorum,
  type GroupsQuorum,
  type LaunchStep,
  type QuorumGroup,
  type Step,
} from "./ast.js";
import { FlowSyntaxError } from "./launch-step.js";

/**
 * The quorum steps of the path builder (#279), read from their arguments: `.acceptedBy(A)` /
 * `.acceptedBy(anyOf(A, B))` right after an agents' launch, `.joinQuorum({ min, max, deadline })`
 * and `.joinQuorumGroups(group(…)…, { deadline })` after it — and the order they impose: an
 * `.acceptedBy(…)` is followed by a quorum join, never by `.join()`. The typed builder makes the
 * wrong forms compile errors; these checks hold for untyped code.
 */

declare const anyOfArbiters: unique symbol;

/** `anyOf(A, B, …)` inside `.acceptedBy(…)` (S57): tried in order, the first that accepts wins. */
export interface AnyOfArbiters {
  readonly [anyOfArbiters]?: true;
  readonly arbiters: readonly [ArbiterClass, ArbiterClass, ...ArbiterClass[]];
}

/** What `.acceptedBy(…)` takes: one `@Arbiter` class, or `anyOf(…)` of several. */
export type ArbiterChoice = ArbiterClass | AnyOfArbiters;

const ANY_OF = new WeakSet<object>();

/** `anyOf(FastCodeArbiter, DeepModelArbiter)`: the model arbiter runs only when the code one rejects. */
export function anyOf(
  ...arbiters: readonly [ArbiterClass, ArbiterClass, ...ArbiterClass[]]
): AnyOfArbiters {
  if (arbiters.length < 2 || arbiters.some((arbiter) => typeof arbiter !== "function"))
    throw new FlowSyntaxError("anyOf(…) takes two or more @Arbiter classes");
  const choice: AnyOfArbiters = Object.freeze({ arbiters: Object.freeze(arbiters) });
  ANY_OF.add(choice);
  return choice;
}

/** The `AcceptedBy` of `.acceptedBy(choice)`. */
export function acceptedByOf(choice: unknown): AcceptedBy {
  if (typeof choice === "function")
    return Object.freeze({ arbiters: Object.freeze([choice as ArbiterClass]) });
  if (typeof choice === "object" && choice !== null && ANY_OF.has(choice))
    return Object.freeze({ arbiters: (choice as AnyOfArbiters).arbiters });
  throw new FlowSyntaxError(".acceptedBy(…) takes an @Arbiter class, or anyOf(A, B, …)");
}

/** The launch `.acceptedBy(…)` extends: right after an agents' launch (or another `.acceptedBy`). */
export function acceptingLaunch(previous: Step | undefined): LaunchStep {
  if (previous?.kind !== StepKind.Launch)
    throw new FlowSyntaxError(
      ".acceptedBy(…) stands right after .toParallelAgents(…), before .joinQuorum(…) / .joinQuorumGroups(…)",
    );
  if (previous.targetKind !== NodeKind.Agent)
    throw new FlowSyntaxError(".acceptedBy(…) judges agents' answers — after .toParallelAgents(…)");
  return previous;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** `{ deadline }`: a positive duration (`seconds()`, `minutes()`, `hours()`), when given. */
function deadlineOf(options: object, call: string): Milliseconds | undefined {
  const deadline: unknown = Reflect.get(options, "deadline");
  if (deadline === undefined) return undefined;
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0)
    throw new FlowSyntaxError(
      `${call}({ deadline }) takes a positive duration: seconds(30), minutes(2), hours(1)`,
    );
  return deadline as Milliseconds;
}

/** `.joinQuorum({ min, max, deadline })`: options are always an object (AC11). */
export function countQuorumOf(options: unknown): CountQuorum {
  if (typeof options !== "object" || options === null)
    throw new FlowSyntaxError(
      ".joinQuorum(…) takes its options as an object: .joinQuorum({ min: 2 }), not .joinQuorum(2)",
    );
  const min: unknown = Reflect.get(options, "min");
  const max: unknown = Reflect.get(options, "max");
  if (!isPositiveInteger(min))
    throw new FlowSyntaxError(".joinQuorum({ min }) takes a positive integer");
  if (max !== undefined && (!isPositiveInteger(max) || max < min))
    throw new FlowSyntaxError(".joinQuorum({ min, max }) takes an integer max of at least min");
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
    throw new FlowSyntaxError(
      ".joinQuorumGroups(…, { deadline }) — min / max do not apply to groups",
    );
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
    throw new FlowSyntaxError(
      ".joinQuorumGroups(…) takes group(…) paths, then { deadline } — min / max do not apply to groups",
    );
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
    throw new FlowSyntaxError("group(…).priority(n) takes a positive integer — 1 is the highest");
  return priority;
}

/** `group(A, B, …).priority(n)` of `.joinQuorumGroups(…)` (#279). */
export interface GroupStart {
  readonly kind: "group";
  readonly agents: readonly Class[];
  readonly priority?: number;
}

/** A group as `.joinQuorumGroups(…)` keeps it: its leading `.returns(…)` are its values. */
export function quorumGroupOf(start: GroupStart, steps: readonly Step[]): QuorumGroup {
  const { agents, priority } = start;
  const firstStep = steps.findIndex((step) => step.kind !== StepKind.Returns);
  const split = firstStep === -1 ? steps.length : firstStep;
  const returns = steps
    .slice(0, split)
    .flatMap((step) => (step.kind === StepKind.Returns ? [step.value] : []));
  const path = Object.freeze({ steps: Object.freeze(steps.slice(split)) });
  const group = { agents, returns: Object.freeze(returns), path };
  return Object.freeze(priority === undefined ? group : { ...group, priority });
}
