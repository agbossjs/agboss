import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { QuorumKind, type CountQuorum, type QuorumGroup } from "../../ast.js";
import type { ComponentName } from "../../registry.js";
import type { FlowLaunch } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { groupAgentNames } from "../quorum-joins.js";
import type { QuorumSite } from "../walked-flow.js";
import { arbiterViolations } from "./arbiters.js";
import type { AnalysisContext } from "./context.js";

/**
 * The quorum rules (#279): a quorum that can never be reached fails assembly
 * (`[flow.quorum-impossible]`: `min` above the agents launched — or above `maxItems` per item — and a
 * group that lists an agent the launch does not run, or more copies than it runs); every arbiter of
 * a launch covers each of its agents (`arbiters.ts`). What a quorum's `.returns(…)` may promise is
 * checked with the join's values (`launches.ts`, `[flow.quorum-return-not-optional]`).
 */

/** How many answers of each agent a launch can give: its copies; per item, `maxItems` (or any). */
function answersOf(launch: FlowLaunch, agent: ComponentName): number {
  const branch = launch.branches.find((candidate) => candidate.node === agent);
  if (branch === undefined) return 0;
  return launch.items === undefined ? branch.copies : (launch.maxItems ?? Infinity);
}

function countViolations(launch: FlowLaunch, quorum: CountQuorum): readonly RuleViolation[] {
  const most = launch.items === undefined ? launch.listed.length : launch.maxItems;
  if (most === undefined || quorum.min <= most) return [];
  const runs =
    launch.items === undefined
      ? `runs ${String(most)} agents`
      : `takes at most ${String(most)} items`;
  const message = `${launchLabel(launch)}: .joinQuorum({ min: ${String(quorum.min)} }) needs ${String(quorum.min)} counted answers, but the launch ${runs} — lower min, or launch more`;
  return [violation("flow.quorum-impossible", message, [launch.launcher])];
}

function groupViolations(launch: FlowLaunch, group: QuorumGroup): readonly RuleViolation[] {
  const agents = groupAgentNames(group.agents);
  const places = new Map<ComponentName, number>();
  for (const agent of agents) places.set(agent, (places.get(agent) ?? 0) + 1);
  const label = `${launchLabel(launch)}: group(${agents.join(", ")})`;
  return [...places].flatMap(([agent, needed]) => {
    const given = answersOf(launch, agent);
    if (needed <= given) return [];
    const message =
      given === 0
        ? `${label} lists ${agent}, which the launch does not run — it can never complete; list agents of the launch`
        : `${label} needs ${String(needed)} counted ${agent} answers, but the launch runs ${String(given)} — it can never complete`;
    return [violation("flow.quorum-impossible", message, [launch.launcher])];
  });
}

function impossibleQuorum(site: QuorumSite): readonly RuleViolation[] {
  const { launch, quorum } = site;
  return quorum.kind === QuorumKind.Count
    ? countViolations(launch, quorum)
    : quorum.groups.flatMap((group) => groupViolations(launch, group));
}

export function quorumRules(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  const all = [
    ...context.walked.quorumJoins.flatMap(impossibleQuorum),
    ...context.walked.launches.flatMap((launch) => arbiterViolations(context, launch)),
  ];
  for (const problem of all) found.set(`${problem.code}|${problem.message}`, problem);
  return [...found.values()];
}
