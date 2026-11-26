import { ComponentKind } from "./runtime/records.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import type { Class } from "../components/injection.js";
import { declarationOf } from "./decorators/declaration.js";
import {
  StepKind,
  type ChooseOneRoute,
  type OneOfStep,
  type OnFinishStep,
  type SubPath,
} from "./ast.js";

/**
 * The branching steps that name no DTO (#1275): `.toOneOf([…side paths])` for a `oneOf(…)` output and
 * `.onFinish(ChildFinish, side path)` for one finish of a child workflow. `side` turns what the
 * builder was given into a side path, or throws.
 */

export type SideOf = (path: unknown, call: string) => SubPath;

const syntaxError = (message: string): ConfigError.FlowSyntax =>
  new ConfigError.FlowSyntax({ message });

/** `.toOneOf([…])`: an array of two or more side paths, in order. */
export function oneOfStepOf(branches: unknown, side: SideOf): OneOfStep {
  if (!Array.isArray(branches) || branches.length < 2)
    throw syntaxError(".toOneOf([…]) takes an array of two or more side paths: toAction(…), …");
  const paths = (branches as readonly unknown[]).map((path) => side(path, ".toOneOf([…])"));
  return { kind: StepKind.OneOf, branches: Object.freeze(paths) };
}

/** `.onFinish(F, path)`: a `@WorkflowFinish` class and the side path it takes. */
export function onFinishStepOf(finish: unknown, path: unknown, side: SideOf): OnFinishStep {
  if (typeof finish !== "function" || declarationOf(finish)?.kind !== ComponentKind.WorkflowFinish)
    throw syntaxError(".onFinish(F, …) takes a @WorkflowFinish class of the child workflow");
  return {
    kind: StepKind.OnFinish,
    finish: finish as Class,
    path: side(path, ".onFinish(F, …)"),
  };
}

/**
 * One `.onRoute(…)` branch: its starter (`toAgent(A)`) is the route's target, the steps after it the
 * route's path (#1278). A child workflow's thunk stays unread until the path is analysed (#1287).
 */
export function routeOf(path: unknown, side: SideOf): ChooseOneRoute {
  const [first, ...rest] = side(path, ".onRoute(…)").steps;
  if (first?.kind !== StepKind.To)
    throw syntaxError(
      ".onRoute(…) starts with toAgent(…), toAction(…), toRouter(…), toWorkflow(…) or toFinish(…)",
    );
  const route = { path: Object.freeze({ steps: Object.freeze(rest) }) };
  return Object.freeze(
    Object.defineProperty(route, "target", { enumerable: true, get: () => first.target }),
  ) as ChooseOneRoute;
}
