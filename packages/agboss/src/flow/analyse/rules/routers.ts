import { ComponentKind } from "../../runtime/records.js";
import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ChooseOneStep } from "../../ast.js";
import { declarationOf, type RouterDeclaration } from "../../decorators/declaration.js";
import { isCodeRouter, routesOf } from "../../decorators/router.js";
import type { FlowNode } from "../flow-graph.js";
import { classLabel } from "../labels.js";
import type { BranchSite } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * Router rules (#272 AC6, #270, #280): the targets of `.onRoute(…)`s (or of `chooseMany([…])`) and of
 * `@Router({ routes })` are the same set (order does not matter) — `[router.routes-mismatch]`; a
 * target listed twice — `[router.duplicate-route]`; `input` required and non-empty —
 * `[router.empty-input]`; a model router's route has its prompt — `[router.no-prompt]`; a model
 * router's model comes from the model cascade (`[model.missing]`, #1279); `.onRoute(…)` only after a
 * router — `[graph.choose-from-non-router]`.
 */

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
  /** `.onRoute(…)`, `.chooseMany([…])`. */
  readonly call: string;
  /** How one target is named there: `.onRoute(…) to `, or nothing. */
  readonly item: string;
}

const ON_ROUTE: RouteListing = { call: ".onRoute(…)", item: "" };

/**
 * The targets a router's choice lists in the flow (`.onRoute(…)`s, or `.chooseMany([…])`, `call`) and
 * its `@Router({ routes })`: the same set, each listed once.
 */
export function routeSetViolations(
  router: FlowNode,
  declaration: RouterDeclaration,
  inFlow: readonly string[],
  call: RouteListing,
): readonly RuleViolation[] {
  const declared = routesOf(declaration.options).map((route) => targetLabel(route.target));
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
  return routeSetViolations(router, declaration, inFlow, ON_ROUTE);
}

function declarationRules(
  context: AnalysisContext,
  router: FlowNode,
  declaration: RouterDeclaration,
): readonly RuleViolation[] {
  const { options } = declaration;
  const found: RuleViolation[] = duplicates(
    routesOf(options).map((route) => targetLabel(route.target)),
  ).map((target) => {
    const message = `${router.name}: @Router({ routes }) lists ${target} twice — list each target once`;
    return violation("router.duplicate-route", message, [router.name]);
  });
  const unprompted = isCodeRouter(options)
    ? []
    : routesOf(options).filter((route) => (route.prompt ?? "").trim() === "");
  if (unprompted.length > 0) {
    const targets = unprompted.map((route) => targetLabel(route.target)).join(", ");
    const message = `${router.name}: the routes to ${targets} have no prompt — the model decides each by its prompt; write one`;
    found.push(violation("router.no-prompt", message, [router.name]));
  }
  if (Object.keys(options.input).length === 0) {
    const message = `${router.name} has an empty input — declare what it chooses by: input: { message: XDto }`;
    found.push(violation("router.empty-input", message, [router.name]));
  }
  return found;
}

export function routerRules(context: AnalysisContext): readonly RuleViolation[] {
  const routers = [...context.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === ComponentKind.Router ? [{ node, declaration: node.declaration }] : [],
  );
  const choices = context.walked.choices.flatMap((site): readonly RuleViolation[] => {
    const node = context.graph.nodes.get(site.node);
    if (node === undefined) return [];
    if (node.declaration.kind === ComponentKind.Router)
      return choiceViolations(node, node.declaration, site);
    const message = `${node.name} is not a router — .onRoute(…) follows .toRouter(…) or onRouter(…)`;
    return [violation("graph.choose-from-non-router", message, [node.name])];
  });
  return [
    ...routers.flatMap(({ node, declaration }) => declarationRules(context, node, declaration)),
    ...choices,
  ];
}
