import type { Class } from "../components/injection.js";
import type { BuiltPath, PathHead, SidePath, StartOfPath } from "./builder-types.js";
import type { Route } from "./generated-types.js";

/**
 * What `.onRoute(subPath)` checks in types (#1278): a router's routes are named once each, by the
 * class that starts the side path (`toAgent(A)…`), and the chain is a path only when none is left.
 */

/** The targets a router decides on, as classes; `never` when the types are not generated. */
export type RoutesOf<TInstance> = [Route<TInstance>] extends [Class] ? Route<TInstance> : never;

/** `unknown` when the path starts with one of the routes not yet named, else a readable error. */
export type RouteCheck<TPath, TRemaining> = [StartOfPath<TPath>] extends [never]
  ? unknown
  : [StartOfPath<TPath>] extends [TRemaining]
    ? unknown
    : {
        readonly __error: "a route is named once, and only a target of @Router({ routes }) is a route";
      };

/** The chain after an `.onRoute(…)`: a built path when every route is named, else only more of them. */
export type RouteStep<THead extends PathHead, TRemaining> = [TRemaining] extends [never]
  ? BuiltPath<THead> & RouteMore<THead, TRemaining>
  : RouteMore<THead, TRemaining> & {
      readonly __error: "a route of the router has no .onRoute(…)";
    };

/** `.onRoute(subPath)`: one more route of the router, `TRemaining` the routes still unnamed. */
export interface RouteMore<THead extends PathHead, TRemaining> {
  onRoute<const TPath extends SidePath>(
    path: TPath & RouteCheck<TPath, TRemaining>,
  ): RouteStep<THead, Exclude<TRemaining, StartOfPath<TPath>>>;
}
