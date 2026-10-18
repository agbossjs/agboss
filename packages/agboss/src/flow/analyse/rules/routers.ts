import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind, type ChooseOneStep } from "../../ast.js";
import { declarationOf, type RouterDeclaration } from "../../decorators/declaration.js";
import { isCodeRouter, routesOf } from "../../decorators/router.js";
import type { FlowNode } from "../flow-graph.js";
import { classLabel } from "../labels.js";
import type { BranchSite } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * Router rules (#272 AC6, #270, #280): the targets of `.chooseOne(route(…)…)` and of
 * `@Router({ routes })` are the same set (order does not matter) — `[router.routes-mismatch]`; a
 * target listed twice — `[router.duplicate-route]`; `input` required and non-empty —
 * `[router.empty-input]`; a model router's model of its own or `defaults.router.model` —
 * `[router.no-model]`; `spawn` / `failure` only before a launch (`.toParallelAgents(…)`, #273), never
 * with `.chooseOne(…)` — `[router.policy-with-choose-one]`; `.chooseOne(…)` only after a router —
 * `[graph.choose-from-non-router]`. Before a launch the routes' own rules are `launchViolations`
 * (`router-launch.ts`, applied by the launch rules, #273).
 */

/** The targets whose route sets a launch policy (`spawn` / `failure`) explicitly. */
const withPolicies = (declaration: RouterDeclaration): readonly string[] =>
  routesOf(declaration.options)
    .filter((route) => route.spawn !== undefined || route.failure !== undefined)
    .map((route) => targetLabel(route.target));

/** A target as a message names it: its component `name`, else its class. */
export const targetLabel = (target: Class): string => {
  const declaration = declarationOf(target);
  return declaration === undefined ? classLabel(target) : declaration.options.name;
};

const duplicates = (labels: readonly string[]): readonly string[] =>
  [...new Set(labels.filter((label, index) => labels.indexOf(label) !== index))].sort();

const missingFrom = (labels: readonly string[], other: readonly string[]): readonly string[] =>
  [...new Set(labels.filter((label) => !other.includes(label)))].sort();

/** How a message names where the flow lists a router's targets. */
export interface RouteListing {
  /** `.chooseOne(…)`, `.toParallelAgents(…)`. */
  readonly call: string;
  /** How one target is named there: `route(…) to `, or nothing. */
  readonly item: string;
}

const CHOOSE_ONE: RouteListing = { call: ".chooseOne(…)", item: "route(…) to " };

/**
 * The targets a router's choice lists in the flow (`.chooseOne(route(…)…)` or a launch's,
 * `call`) and its `@Router({ routes })`: the same set, each listed once.
 */
export function routeSetViolations(
  router: FlowNode,
  declaration: RouterDeclaration,
  inFlow: readonly string[],
  call: RouteListing,
): readonly RuleViolation[] {
  const declared = declaration.options.routes.map((route) => targetLabel(route.target));
  const notDeclared = missingFrom(inFlow, declared);
  const notInFlow = missingFrom(declared, inFlow);
  const found: RuleViolation[] = duplicates(inFlow).map((target) => {
    const message = `${router.name}: ${call.item}${target} is listed twice in ${call.call} — list each target once`;
    return violation("router.duplicate-route", message, [router.name]);
  });
  if (notDeclared.length > 0 || notInFlow.length > 0) {
    const parts = [
      notDeclared.length > 0 ? `not in @Router({ routes }): ${notDeclared.join(", ")}` : "",
      notInFlow.length > 0 ? `missing in ${call.call}: ${notInFlow.join(", ")}` : "",
    ].filter((part) => part !== "");
    const message = `${router.name}: the flow's routes and @Router({ routes }) differ — ${parts.join("; ")}`;
    found.push(violation("router.routes-mismatch", message, [router.name]));
  }
  return found;
}

function choiceViolations(
  router: FlowNode,
  declaration: RouterDeclaration,
  site: BranchSite<ChooseOneStep>,
): readonly RuleViolation[] {
  const inFlow = site.step.routes.map((route) => targetLabel(route.target));
  const found = [...routeSetViolations(router, declaration, inFlow, CHOOSE_ONE)];
  const policies = withPolicies(declaration);
  if (policies.length > 0) {
    const message =
      `${router.name}: spawn / failure on the routes to ${policies.join(", ")} apply to a parallel ` +
      `launch (.toParallelAgents(…)) — remove them for .chooseOne(…)`;
    found.push(violation("router.policy-with-choose-one", message, [router.name]));
  }
  return found;
}

function declarationRules(
  context: AnalysisContext,
  router: FlowNode,
  declaration: RouterDeclaration,
): readonly RuleViolation[] {
  const { options } = declaration;
  const found: RuleViolation[] = duplicates(
    options.routes.map((route) => targetLabel(route.target)),
  ).map((target) => {
    const message = `${router.name}: @Router({ routes }) lists ${target} twice — list each target once`;
    return violation("router.duplicate-route", message, [router.name]);
  });
  if (Object.keys(options.input).length === 0) {
    const message = `${router.name} has an empty input — declare what it chooses by: input: { message: XDto }`;
    found.push(violation("router.empty-input", message, [router.name]));
  }
  const hasModel =
    options.model !== undefined || context.workflow.defaults?.router?.model !== undefined;
  if (!isCodeRouter(options) && !hasModel) {
    const message = `${router.name} uses DecidedBy.Model but has no model — set model or defaults.router.model`;
    found.push(violation("router.no-model", message, [router.name]));
  }
  return found;
}

export function routerRules(context: AnalysisContext): readonly RuleViolation[] {
  const routers = [...context.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Router ? [{ node, declaration: node.declaration }] : [],
  );
  const choices = context.walked.choices.flatMap((site): readonly RuleViolation[] => {
    const node = context.graph.nodes.get(site.node);
    if (node === undefined) return [];
    if (node.declaration.kind === NodeKind.Router)
      return choiceViolations(node, node.declaration, site);
    const message = `${node.name} is not a router — .chooseOne(…) follows .toRouter(…) or router(…)`;
    return [violation("graph.choose-from-non-router", message, [node.name])];
  });
  return [
    ...routers.flatMap(({ node, declaration }) => declarationRules(context, node, declaration)),
    ...choices,
  ];
}
