import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { RouterDeclaration } from "../../decorators/declaration.js";
import {
  isCodeRouter,
  onDemandRoutesOf,
  SpawnPolicy,
  type AnyRouterRoute,
} from "../../decorators/router.js";
import { targetLabel } from "./routers.js";

/**
 * The rules of a router before a launch (`.toParallelAgents(…)`, #273, #280 S47, #273 S50): a model
 * router's routes say `spawn` explicitly — `[router.spawn-required]`; an `Always` route has no
 * prompt (no model reads it) — `[router.prompt-on-always]`; an `OnDemand` one has one (the model
 * decides it by it) — `[router.no-prompt]`; and at least one route is `OnDemand` — a code router's
 * route by its default — else the router decides nothing: `[router.all-routes-always]`.
 */

const targetsOf = (routes: readonly AnyRouterRoute[]): string =>
  routes.map((route) => targetLabel(route.target)).join(", ");

function modelRouteViolations(
  routerName: string,
  routes: readonly AnyRouterRoute[],
): readonly RuleViolation[] {
  const unstated = routes.filter((route) => route.spawn === undefined);
  const prompted = routes.filter(
    (route) => route.spawn === SpawnPolicy.Always && route.prompt !== undefined,
  );
  const unprompted = routes.filter(
    (route) => route.spawn === SpawnPolicy.OnDemand && (route.prompt ?? "").trim() === "",
  );
  const found: RuleViolation[] = [];
  if (unstated.length > 0) {
    const message = `${routerName}: before .toParallelAgents(…) every route of a model router says spawn: SpawnPolicy.Always or SpawnPolicy.OnDemand — missing on ${targetsOf(unstated)}`;
    found.push(violation("router.spawn-required", message, [routerName]));
  }
  if (prompted.length > 0) {
    const message = `${routerName}: the routes to ${targetsOf(prompted)} are spawn: SpawnPolicy.Always — the framework launches them and no model reads their prompt; remove it`;
    found.push(violation("router.prompt-on-always", message, [routerName]));
  }
  if (unprompted.length > 0) {
    const message = `${routerName}: the routes to ${targetsOf(unprompted)} are spawn: SpawnPolicy.OnDemand — the model decides each by its prompt; write one`;
    found.push(violation("router.no-prompt", message, [routerName]));
  }
  return found;
}

export function launchViolations(
  routerName: string,
  declaration: RouterDeclaration,
): readonly RuleViolation[] {
  const { options } = declaration;
  const found = isCodeRouter(options) ? [] : modelRouteViolations(routerName, options.routes);
  const isStated = found.every((problem) => problem.code !== "router.spawn-required");
  if (!isStated || onDemandRoutesOf(options).length > 0) return found;
  const message = `${routerName}: every route is spawn: SpawnPolicy.Always, so it decides nothing — set spawn: SpawnPolicy.OnDemand on the routes it chooses, or launch them with .toParallelAgents(…) without a router`;
  return [...found, violation("router.all-routes-always", message, [routerName])];
}
