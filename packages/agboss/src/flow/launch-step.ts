import type { Class } from "../components/injection.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type ForEachItemStep,
  type InParallelStep,
  type JoinStep,
  type LaunchStep,
  type LaunchTargetKind,
  type PathSource,
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
 * `.joinQuorumGroups(…)` — each `.onGroup(…)` continues its own path (#279, #1284).
 */
function afterJoinProblem(join: JoinStep, next: Step): string | undefined {
  if (join.quorum?.kind === QuorumKind.Groups)
    return "nothing follows .joinQuorumGroups(…) but its .onError(…) and .onGroup(…)s — each group continues its own path";
  if (next.kind === StepKind.To) return undefined;
  return "after .join() the path goes on with .onError(…) and one .to…(…)";
}

/** Why a quorum join cannot follow the launch before it: groups need a launch of fixed branches, not one per item. */
function quorumProblem(launch: LaunchStep | InParallelStep | ForEachItemStep, join: JoinStep) {
  if (join.quorum?.kind === QuorumKind.Groups && launch.kind === StepKind.ForEachItem)
    return "a .forEachItem(…) launch runs one target per item — .joinQuorum(…) counts its answers; .joinQuorumGroups(…) groups different targets";
  if (launch.kind === StepKind.Launch && launch.targetKind !== NodeKind.Agent)
    return "a quorum counts agents' answers — .joinQuorum(…) follows .inParallel([…]), .forEachItem(…) or .toParallelAgents(…)";
  return undefined;
}

/** Why a join cannot follow the launch before it: a launch with an arbiter needs a quorum (AC12). */
function joinProblem(
  launch: LaunchStep | InParallelStep | ForEachItemStep,
  join: JoinStep,
): string | undefined {
  if (join.quorum === undefined)
    return launch.arbitratedBy === undefined
      ? undefined
      : ".arbitratedBy(…) is followed by .joinQuorum(…) or .joinQuorumGroups(…), not .join()";
  return quorumProblem(launch, join);
}

/** Whether a step launches branches that a `.join()` follows. */
export const isLaunching = (
  step: Step | undefined,
): step is LaunchStep | InParallelStep | ForEachItemStep =>
  step?.kind === StepKind.Launch ||
  step?.kind === StepKind.InParallel ||
  step?.kind === StepKind.ForEachItem;

/** Why `next` cannot follow `previous` around a launch; undefined when it can. */
export function launchOrderProblem(previous: Step | undefined, next: Step): string | undefined {
  const isLaunch = isLaunching(previous);
  if (isLaunch !== (next.kind === StepKind.Join))
    return isLaunch
      ? "a parallel launch is followed by .join()"
      : ".join() follows a parallel launch: .inParallel([…]) or .forEachItem(…)";
  if (isLaunching(previous) && next.kind === StepKind.Join) return joinProblem(previous, next);
  return previous?.kind === StepKind.Join ? afterJoinProblem(previous, next) : undefined;
}

/** Whether a launch right after `last` (or at the start of `source`'s path) follows a router. */
export const afterRouter = (last: Step | undefined, source: PathSource | undefined): boolean =>
  last === undefined
    ? source?.kind === NodeKind.Router
    : last.kind === StepKind.To && last.targetKind === NodeKind.Router;

/** Where a launch stands: right after a router (the step before it, or the path's own source). */
export const siteOf = (last: Step | undefined, source: PathSource | undefined): LaunchSite => ({
  followsRouter: afterRouter(last, source),
});
