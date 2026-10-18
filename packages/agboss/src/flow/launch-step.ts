import { AGBossError } from "../core/errors.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type JoinStep,
  type ComponentClass,
  type LaunchStep,
  type LaunchTargetKind,
  type Step,
} from "./ast.js";
import { isWrapper, Wrapper } from "./dto-wrappers.js";

/**
 * The launch step of the path builder (#273): `.toParallelAgents(A, B, …, { maxConcurrency,
 * maxItems })` — and `.toParallelWorkflows(W, …)`, one child per item (#263) — read from its arguments, and the order a launch imposes on the steps around it — a
 * launch is followed by `.join()`, a join by its `.onJoinError(…)`, `.returns(…)` and one `.to…(…)`.
 * The typed builder makes the wrong forms compile errors; these checks hold for untyped code.
 */

/** A builder used where the grammar does not allow it (only reachable from untyped code). */
export class FlowSyntaxError extends AGBossError {
  static override readonly code: string = "flow.syntax";
}

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
    throw new FlowSyntaxError(`${call}(…, { ${key} }) takes a positive integer`);
  return value;
}

function optionsOf(last: unknown, call: string): ReadOptions {
  if (typeof last !== "object" || last === null)
    throw new FlowSyntaxError(
      `${call}(…) takes component classes, then { maxConcurrency, maxItems }`,
    );
  const maxConcurrency = limitOf(last, "maxConcurrency", call);
  const maxItems = limitOf(last, "maxItems", call);
  return {
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

/** Whether the step before carries a list: `.returns(listOf(XDto))` right before the launch. */
const carriesList = (previous: Step | undefined): boolean =>
  previous?.kind === StepKind.Returns &&
  isWrapper(previous.value.shape) &&
  previous.value.shape.kind === Wrapper.List;

/** Where a launch stands: the step before it, and whether that step is a router. */
export interface LaunchSite {
  readonly previous: Step | undefined;
  readonly followsRouter: boolean;
}

/** A child workflow launch (#263) runs one child per item: one workflow, right after a list. */
function childLaunchProblem(targets: readonly unknown[], site: LaunchSite): string | undefined {
  if (targets.length !== 1)
    return "toParallelWorkflows(W, { maxConcurrency, maxItems }) launches one child workflow class";
  return carriesList(site.previous)
    ? undefined
    : "toParallelWorkflows(W, …) runs one child per item — write .returns(listOf(XDto)) right before it";
}

/** Why the launch cannot stand where it does: a router launches agents only; a child, per item. */
function siteProblem(
  targetKind: LaunchTargetKind,
  targets: readonly unknown[],
  site: LaunchSite,
): string | undefined {
  if (site.followsRouter && targetKind !== NodeKind.Agent)
    return `a router launches agents only — .toParallelAgents(…), not ${LAUNCH_CALLS[targetKind]}(…)`;
  return targetKind === NodeKind.Workflow ? childLaunchProblem(targets, site) : undefined;
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
    throw new FlowSyntaxError(`${call}(…) takes one or more component classes`);
  const problem = siteProblem(targetKind, targets, site);
  if (problem !== undefined) throw new FlowSyntaxError(problem);
  const options = hasOptions ? optionsOf(last, call) : {};
  return Object.freeze({
    kind: StepKind.Launch,
    targetKind,
    targets: Object.freeze([...(targets as readonly ComponentClass[])]),
    perItem: targets.length === 1 && carriesList(site.previous),
    ...options,
  });
}

/**
 * What may follow a join: `.onError(…)` is named, anything but a transition refused; nothing follows
 * `.joinQuorumGroups(…)` — each group continues its own path (#279).
 */
function afterJoinProblem(join: JoinStep, next: Step): string | undefined {
  if (join.quorum?.kind === QuorumKind.Groups)
    return "nothing follows .joinQuorumGroups(…) but .onJoinError(…) — each group continues its own path";
  if (next.kind === StepKind.To) return undefined;
  return next.kind === StepKind.OnError
    ? ".onError(…) does not follow a join — use .onJoinError(E, …) right after .join()"
    : "after .join() the path goes on with .onJoinError(…), .returns(…) and one .to…(…)";
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
