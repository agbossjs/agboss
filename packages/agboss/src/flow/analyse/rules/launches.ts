import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { EdgeKind, type FlowEdge, type FlowLaunch, type JoinEdge } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { dtoLabel, shapeLabel } from "../labels.js";
import { slotOfDto } from "../scope.js";
import type { AnalysisContext } from "./context.js";
import { chain, sorted } from "./returns.js";
import { launchViolations } from "./router-launch.js";
import { routeSetViolations, type RouteListing } from "./routers.js";

/**
 * The launch rules (#273): a per-item launch has `maxItems` (`[launch.max-items-required]`) and
 * only it (`[launch.max-items-without-list]`), and its target reads the item
 * (`[launch.item-not-read]`); a branch is continued by its join only (`[launch.branch-continued]`);
 * `.join().returns(…)` names exactly what the branches give (`[flow.returns-mismatch]`); a router's
 * launch lists its routes (`[router.routes-mismatch]`) and follows the routes' launch rules
 * (`launchViolations`). Policies exist only on a router's routes, so a launch from an agent, a
 * start or an action has none.
 */

function widthViolations(context: AnalysisContext, launch: FlowLaunch): readonly RuleViolation[] {
  const label = launchLabel(launch);
  const nodes = [launch.launcher];
  const { items, maxItems } = launch;
  if (items === undefined)
    return maxItems === undefined
      ? []
      : [
          violation(
            "launch.max-items-without-list",
            `${label}: { maxItems } bounds a per-item launch — one target right after .returns(listOf(XDto)); remove it here`,
            nodes,
          ),
        ];
  const list = shapeLabel(items);
  const found: RuleViolation[] = [];
  if (maxItems === undefined)
    found.push(
      violation(
        "launch.max-items-required",
        `${label}: a per-item launch runs once per item of ${list} — set { maxItems } to bound how many run`,
        nodes,
      ),
    );
  const { element } = items;
  const [branch] = launch.branches;
  if (typeof element !== "function" || branch === undefined) return found;
  const reads = (context.fields.get(branch.node) ?? []).some(
    (field) => field.slot === slotOfDto(element),
  );
  if (!reads) {
    const item = dtoLabel(element);
    const message = `${branch.node} runs once per ${item} of ${list} (${label}), but reads no ${item} — add an input field of type ${item}`;
    found.push(violation("launch.item-not-read", message, [branch.node]));
  }
  return found;
}

/** A launch's branch continued elsewhere: its join continues it. */
function continuedBranches(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const launch of context.walked.launches) {
    for (const { node } of launch.branches) {
      if (!context.graph.edges.some((edge) => edge.from === node) || found.has(node)) continue;
      const message = `${node} is a branch of ${launchLabel(launch)}, so its join continues it — it is not continued anywhere else; make a second class (…options, name: "…") for the other path`;
      found.set(node, violation("launch.branch-continued", message, [node]));
    }
  }
  return [...found.values()];
}

/** `.join().returns(…)` against what the branches give. */
function joinReturnsViolations(join: JoinEdge): readonly RuleViolation[] {
  const label = launchLabel(join.launch);
  const nodes = [join.launch.launcher];
  const problems = join.groups.flatMap((group) =>
    group.problem === undefined
      ? []
      : [violation("flow.returns-mismatch", `${label}: ${group.problem}`, nodes)],
  );
  const want = join.groups.flatMap((group) =>
    group.shape === undefined ? [] : [shapeLabel(group.shape)],
  );
  const got = join.written.map(shapeLabel);
  if (problems.length > 0 || sorted(want) === sorted(got)) return problems;
  const message =
    want.length === 0
      ? `the join of ${label} gives nothing — its actions have no output; remove ${chain(got)} after .join()`
      : `the join of ${label} gives ${sorted(want)} — write .join()${chain(want)}` +
        (got.length === 0 ? "" : `, not .join()${chain(got)}`);
  return [violation("flow.returns-mismatch", message, nodes)];
}

const ROUTER_LAUNCH: RouteListing = { call: ".toParallelAgents(…)", item: "" };

function routerLaunchViolations(
  context: AnalysisContext,
  launch: FlowLaunch,
): readonly RuleViolation[] {
  const router = context.graph.nodes.get(launch.launcher);
  if (router?.declaration.kind !== NodeKind.Router) return [];
  return [
    ...routeSetViolations(router, router.declaration, launch.listed, ROUTER_LAUNCH),
    ...launchViolations(router.name, router.declaration),
  ];
}

const joinsOf = (edges: readonly FlowEdge[]): readonly JoinEdge[] =>
  edges.flatMap((edge) =>
    edge.kind === EdgeKind.Join && edge.join !== undefined ? [edge.join] : [],
  );

export function launchRules(context: AnalysisContext): readonly RuleViolation[] {
  const { launches } = context.walked;
  return [
    ...launches.flatMap((launch) => widthViolations(context, launch)),
    ...launches.flatMap((launch) => routerLaunchViolations(context, launch)),
    ...continuedBranches(context),
    ...joinsOf(context.graph.edges).flatMap(joinReturnsViolations),
  ];
}
