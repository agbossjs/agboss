import type { Class } from "../components/injection.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type JoinStep,
  type LaunchStep,
  type LaunchTargetKind,
  type Step,
} from "./ast.js";
import { FlowSyntaxError } from "./flow-syntax-error.js";
import { withTargets, type TargetRef } from "./target-ref.js";

/**
 * The launch step of the path builder (#273): `.toParallelAgents(A, B, …, { maxConcurrency,
 * maxItems })` — and `.toParallelWorkflows(W, …)`, one child per item (#263) — read from its arguments, and the order a launch imposes on the steps around it — a
 * launch is followed by `.join()`, a join by its `.onError(…)` and one `.to…(…)`.
 * The typed builder makes the wrong forms compile errors; these checks hold for untyped code.
 */

export { FlowSyntaxError } from "./flow-syntax-error.js";

/** The call that launches each kind. */
export const LAUNCH_CALLS: Readonly<Record<LaunchTargetKind, string>> = {
  [NodeKind.Agent]: "toParallelAgents",
  [NodeKind.Action]: "toParallelActions",
  [NodeKind.Workflow]: "toParallelWorkflows",
};

/** `{ maxConcurrency, maxItems }`, read from the last argument. */
interface ReadOptions {
  readonly maxConcurrency?: number;
  readonly maxItems?: number;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

function limitOf(options: object, key: keyof ReadOptions, call: string): number | undefined {
  const value: unknown = Reflect.get(options, key);
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value))
    throw new FlowSyntaxError({ message: `${call}(…, { ${key} }) takes a positive integer` });
  return value;
}

function optionsOf(last: unknown, call: string): ReadOptions {
  if (typeof last !== "object" || last === null)
    throw new FlowSyntaxError({
      message: `${call}(…) takes component classes, then { maxConcurrency, maxItems }`,
    });
  const maxConcurrency = limitOf(last, "maxConcurrency", call);
  const maxItems = limitOf(last, "maxItems", call);
  return {
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

/** Where a launch stands: whether the step before it is a router. */
export interface LaunchSite {
  readonly followsRouter: boolean;
}

/** A child workflow launch (#263) runs one child per item: one workflow class. */
function childLaunchProblem(targets: readonly unknown[]): string | undefined {
  return targets.length === 1
    ? undefined
    : "toParallelWorkflows(W, { maxConcurrency, maxItems }) launches one child workflow class";
}

/** Why the launch cannot stand where it does: a router launches agents only; a child, per item. */
function siteProblem(
  targetKind: LaunchTargetKind,
  targets: readonly unknown[],
  site: LaunchSite,
): string | undefined {
  if (site.followsRouter && targetKind !== NodeKind.Agent)
    return `a router launches agents only — .toParallelAgents(…), not ${LAUNCH_CALLS[targetKind]}(…)`;
  return targetKind === NodeKind.Workflow ? childLaunchProblem(targets) : undefined;
}

/** The launch step of `.toParallelAgents(…)` / `.toParallelActions(…)` / `.toParallelWorkflows(…)`. */
export function launchStepOf(
  targetKind: LaunchTargetKind,
  args: readonly unknown[],
  site: LaunchSite,
): LaunchStep {
  const call = LAUNCH_CALLS[targetKind];
  const last = args[args.length - 1];
  const hasOptions = args.length > 0 && typeof last !== "function";
  const targets = hasOptions ? args.slice(0, -1) : args;
  if (targets.length === 0 || targets.some((target) => typeof target !== "function"))
    throw new FlowSyntaxError({ message: `${call}(…) takes one or more component classes` });
  const problem = siteProblem(targetKind, targets, site);
  if (problem !== undefined) throw new FlowSyntaxError({ message: problem });
  const options = hasOptions ? optionsOf(last, call) : {};
  const rest = { kind: StepKind.Launch as const, targetKind, ...options };
  // a child workflow may be named by a thunk (#1287), read when the flow is analysed
  return Object.freeze(
    targetKind === NodeKind.Workflow
      ? withTargets("targets", targets as readonly TargetRef[], rest)
      : { ...rest, targets: Object.freeze([...(targets as readonly Class[])]) },
  );
}

/**
 * What may follow a join (its `.onError(…)` is the join's own, `PathBuilder.onError`): anything but a transition is refused; nothing follows
 * `.joinQuorumGroups(…)` — each group continues its own path (#279).
 */
function afterJoinProblem(join: JoinStep, next: Step): string | undefined {
  if (join.quorum?.kind === QuorumKind.Groups)
    return "nothing follows .joinQuorumGroups(…) but .onError(…) — each group continues its own path";
  if (next.kind === StepKind.To) return undefined;
  return "after .join() the path goes on with .onError(…) and one .to…(…)";
}

/** Why a join cannot follow the launch before it: a launch with arbiters needs a quorum (AC12). */
function quorumJoinProblem(launch: LaunchStep, isQuorum: boolean): string | undefined {
  if (!isQuorum)
    return launch.acceptedBy === undefined
      ? undefined
      : ".acceptedBy(…) is followed by .joinQuorum(…) or .joinQuorumGroups(…), not .join()";
  return launch.targetKind === NodeKind.Agent
    ? undefined
    : "a quorum counts agents' answers — .joinQuorum(…) follows .toParallelAgents(…)";
}

/** Why `next` cannot follow `previous` around a launch; undefined when it can. */
export function launchOrderProblem(previous: Step | undefined, next: Step): string | undefined {
  const isLaunch = previous?.kind === StepKind.Launch;
  if (isLaunch !== (next.kind === StepKind.Join))
    return isLaunch
      ? "a parallel launch is followed by .join()"
      : ".join() follows a parallel launch: .toParallelAgents(…), .toParallelActions(…) or .toParallelWorkflows(…)";
  if (previous?.kind === StepKind.Launch && next.kind === StepKind.Join)
    return quorumJoinProblem(previous, next.quorum !== undefined);
  return previous?.kind === StepKind.Join ? afterJoinProblem(previous, next) : undefined;
}
