/**
 * The 0.1.0 router engine (#1313): `ROUTER_FACTORY` and what it makes, no public API since the injectable
 * `DecisionModel` took its place; the framework's own routers still run on it.
 */
export { ROUTER_FACTORY } from "./components/runtime.js";
export type {
  RouteOption,
  RouteOutcome,
  RouteRequest,
  RouterDecision,
  RouterEngine,
} from "./routers/index.js";
