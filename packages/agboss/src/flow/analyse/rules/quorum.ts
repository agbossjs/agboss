import { workingCalendarViolations } from "../../../calendar/calendar-source.js";
import { isWorkingDuration } from "../../../units/index.js";
import { spanText } from "../../../units/working-time.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { QuorumKind, type CountQuorum, type QuorumGroup } from "../../ast.js";
import type { ComponentName } from "../../registry.js";
import { itemBoundOf, type FlowLaunch } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { groupTargetNames } from "../quorum-joins.js";
import type { QuorumSite } from "../walked-flow.js";
import { arbiterViolations } from "./arbiters.js";
import type { AnalysisContext } from "./context.js";

/**
 * The quorum rules (#279): a quorum that can never be reached fails assembly
 * (`[flow.quorum-impossible]`: `min` above the agents launched — or above `maxItems` per item — and a
 * group that lists an agent the launch does not run, or more copies than it runs); every arbiter of
 * a launch covers each of its agents (`arbiters.ts`). What the counted answers give is
 * what a consumer may require of them is `[input.missing-on-path]`.
 */

/** How many answers of each agent a launch can give: its copies; per item, `maxItems` (or any). */
function answersOf(launch: FlowLaunch, agent: ComponentName): number {
  const branch = launch.branches.find((candidate) => candidate.node === agent);
  if (branch === undefined) return 0;
  return launch.items === undefined ? branch.copies : (itemBoundOf(launch) ?? Infinity);
}

function countViolations(launch: FlowLaunch, quorum: CountQuorum): readonly RuleViolation[] {
  const most = launch.items === undefined ? launch.listed.length : itemBoundOf(launch);
  if (most === undefined || quorum.min <= most) return [];
  const runs =
    launch.items === undefined
      ? `runs ${String(most)} agents`
      : `takes at most ${String(most)} items`;
  const message = `${launchLabel(launch)}: .joinQuorum({ min: ${String(quorum.min)} }) needs ${String(quorum.min)} counted answers, but the launch ${runs} — lower min, or launch more`;
  return [violation("flow.quorum-impossible", message, [launch.launcher])];
}

function groupViolations(launch: FlowLaunch, group: QuorumGroup): readonly RuleViolation[] {
  const targets = groupTargetNames(group.targets);
  const places = new Map<ComponentName, number>();
  for (const target of targets) places.set(target, (places.get(target) ?? 0) + 1);
  const label = `${launchLabel(launch)}: .onGroup([${targets.join(", ")}], …)`;
  return [...places].flatMap(([target, needed]) => {
    const given = answersOf(launch, target);
    if (needed <= given) return [];
    const message =
      given === 0
        ? `${label} lists ${target}, which the launch does not run — it can never complete; list targets of the launch`
        : `${label} needs ${String(needed)} counted ${target} answers, but the launch runs ${String(given)} — it can never complete`;
    return [violation("flow.quorum-impossible", message, [launch.launcher])];
  });
}

/**
 * `[calendar.required-for-working-duration]` (#1306): a quorum whose `deadline` is working time
 * names the `@WorkingCalendar` class that counts it (`{ deadline: workDays(5), calendar: C }`), and
 * that class is a valid one (`[working-calendar.invalid]`). The calendar of a quorum is the
 * quorum's own — never the application's, which serves pauses.
 */
function calendarViolations(site: QuorumSite): readonly RuleViolation[] {
  const { launch, quorum } = site;
  if (!isWorkingDuration(quorum.deadline)) return [];
  const label = `${launchLabel(launch)}: ${quorum.kind === QuorumKind.Count ? ".joinQuorum" : ".joinQuorumGroups"}({ deadline: ${spanText(quorum.deadline)} })`;
  if (quorum.calendar === undefined)
    return [
      violation(
        "calendar.required-for-working-duration",
        `${label} is working time and needs the calendar that counts it — add calendar: YourWorkingCalendar (a @WorkingCalendar class)`,
        [launch.launcher],
      ),
    ];
  // the class is created by the quorum's workflow, so it needs no listing in providers
  return workingCalendarViolations(label, quorum.calendar, [quorum.calendar]);
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
    ...context.walked.quorumJoins.flatMap(calendarViolations),
    ...context.walked.launches.flatMap((launch) => arbiterViolations(context, launch)),
  ];
  for (const problem of all) found.set(`${problem.code}|${problem.message}`, problem);
  return [...found.values()];
}
