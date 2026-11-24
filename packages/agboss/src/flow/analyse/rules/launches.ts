import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { codeOfErrorClass, errorRecordOf, recordMatches } from "../../../core/error-record.js";
import { LimitError } from "../../../core/error-families/limit-errors.js";
import { usd } from "../../../units/index.js";
import {
  EdgeKind,
  isStrictItems,
  type FlowEdge,
  type FlowLaunch,
  type JoinEdge,
} from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { dtoLabel, shapeLabel } from "../labels.js";
import { slotOfDto } from "../scope.js";
import type { AnalysisContext } from "./context.js";
import { launchViolations } from "./router-launch.js";
import { routeSetViolations, type RouteListing } from "./routers.js";

/**
 * The launch rules (#273): a per-item launch has `maxItems` (`[launch.max-items-required]`) and
 * only it (`[launch.max-items-without-list]`), and its target reads the item
 * (`[launch.item-not-read]`); a branch is continued by its join only (`[launch.branch-continued]`);
 * a join's value is one the branches' outputs can give (`[launch.unjoinable-output]`); a router's
 * launch lists its routes (`[router.routes-mismatch]`) and follows the routes' launch rules
 * (`launchViolations`). Policies exist only on a router's routes, so a launch from an agent, a
 * start or an action has none.
 */

/** The rules of `.inParallel([…])` and `.forEachItem(…)` (#1279, #1280). */
function parallelViolations(
  context: AnalysisContext,
  launch: FlowLaunch,
): readonly RuleViolation[] {
  const label = launchLabel(launch);
  const nodes = [launch.launcher];
  const found: RuleViolation[] = launch.branches
    .filter((branch) => branch.skipDiffers === true)
    .map((branch) =>
      violation(
        "launch.skip-differs",
        `${label}: ${branch.node} is listed more than once with different .onError(E, skip()) — give every copy the same skips`,
        nodes,
      ),
    );
  if (launch.form === "for-each-item" && launch.items === undefined)
    found.push(
      violation(
        "launch.for-each-item-no-list",
        `${label}: .forEachItem(…) runs the step once per item of the list the step before it gives — that step gives no list`,
        nodes,
      ),
    );
  if (isStrictItems(launch) && !hasItemsHandler(context, launch))
    found.push(
      violation(
        "launch.max-items-handler-required",
        `${label}: { maxItems } throws LimitError.Items past it — add .onError(LimitError.Items, …) (or LimitError, AGBossError) after the join`,
        nodes,
      ),
    );
  return found;
}

/** Whether a join handler of the launch catches `LimitError.Items`: its class, a parent of it, or `Error`. */
function hasItemsHandler(context: AnalysisContext, launch: FlowLaunch): boolean {
  const sample = errorRecordOf(
    new LimitError.Items({ path: [], spentUsd: usd(0), node: "", limit: 0, actual: 1 }),
  );
  return context.walked.joinErrorHandlers.some(
    (site) => site.launch === launch && recordMatches(sample, codeOfErrorClass(site.handler.error)),
  );
}

function widthViolations(context: AnalysisContext, launch: FlowLaunch): readonly RuleViolation[] {
  if (launch.form !== undefined) return parallelViolations(context, launch);
  const label = launchLabel(launch);
  const nodes = [launch.launcher];
  const { items, maxItems } = launch;
  if (items === undefined)
    return maxItems === undefined
      ? []
      : [
          violation(
            "launch.max-items-without-list",
            `${label}: { maxItems } bounds a per-item launch — one target right after a step that gives a list; remove it here`,
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
  // a child workflow takes its item through a start (`[graph.no-matching-start]`, #263)
  if (typeof element !== "function" || branch === undefined) return found;
  if (branch.kind === NodeKind.Workflow) return found;
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

/** A join's value the branches' outputs cannot give: a list of lists, a lone `oneOf`. */
function joinViolations(join: JoinEdge): readonly RuleViolation[] {
  const label = join.group === undefined ? launchLabel(join.launch) : groupLabel(join);
  return join.groups.flatMap((group) =>
    group.problem === undefined
      ? []
      : [
          violation("launch.unjoinable-output", `${label}: ${group.problem}`, [
            join.launch.launcher,
          ]),
        ],
  );
}

/** `<launch> group(A, B)` of `.joinQuorumGroups(…)`. */
const groupLabel = (join: JoinEdge): string =>
  `${launchLabel(join.launch)} group(${join.group?.agents.join(", ") ?? ""})`;

const ROUTER_LAUNCH: RouteListing = { call: ".toParallelAgents(…)", item: "" };
const CHOOSE_MANY: RouteListing = { call: ".chooseMany([…])", item: "" };

function routerLaunchViolations(
  context: AnalysisContext,
  launch: FlowLaunch,
): readonly RuleViolation[] {
  const router = context.graph.nodes.get(launch.launcher);
  if (router?.declaration.kind !== NodeKind.Router) return [];
  // `toRouter(R).chooseMany([…])` (#1279b): the branches are R's routes, all chosen by it
  if (launch.chooser !== undefined)
    return routeSetViolations(router, router.declaration, launch.chooser.routes, CHOOSE_MANY);
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
    ...joinsOf(context.graph.edges).flatMap(joinViolations),
  ];
}
