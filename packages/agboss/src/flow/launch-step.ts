import {
  QuorumKind,
  StepKind,
  type ForEachItemStep,
  type InParallelStep,
  type JoinStep,
  type Step,
} from "./ast.js";

/**
 * The order a launch imposes on the steps around it (#273): a launch (`.inParallel([…])`,
 * `.forEachItem(…)`) is followed by `.join()`, a join by its `.onError(…)` and one `.to…(…)`.
 * The typed builder makes the wrong forms compile errors; these checks hold for untyped code.
 */

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
function quorumProblem(launch: InParallelStep | ForEachItemStep, join: JoinStep) {
  if (join.quorum?.kind === QuorumKind.Groups && launch.kind === StepKind.ForEachItem)
    return "a .forEachItem(…) launch runs one target per item — .joinQuorum(…) counts its answers; .joinQuorumGroups(…) groups different targets";
  return undefined;
}

/** Why a join cannot follow the launch before it: a launch with an arbiter needs a quorum (AC12). */
function joinProblem(launch: InParallelStep | ForEachItemStep, join: JoinStep): string | undefined {
  if (join.quorum === undefined)
    return launch.arbitratedBy === undefined
      ? undefined
      : ".arbitratedBy(…) is followed by .joinQuorum(…) or .joinQuorumGroups(…), not .join()";
  return quorumProblem(launch, join);
}

/** Whether a step launches branches that a `.join()` follows. */
export const isLaunching = (step: Step | undefined): step is InParallelStep | ForEachItemStep =>
  step?.kind === StepKind.InParallel || step?.kind === StepKind.ForEachItem;

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
