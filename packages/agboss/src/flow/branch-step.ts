import type { Class } from "../components/injection.js";
import { declarationOf } from "./decorators/declaration.js";
import { NodeKind, StepKind, type OneOfStep, type OnFinishStep, type SubPath } from "./ast.js";
import { FlowSyntaxError } from "./launch-step.js";

/**
 * The branching steps that name no DTO (#1275): `.toOneOf([…side paths])` for a `oneOf(…)` output and
 * `.onFinish(ChildFinish, side path)` for one finish of a child workflow. `side` turns what the
 * builder was given into a side path, or throws.
 */

export type SideOf = (path: unknown, call: string) => SubPath;

const syntaxError = (message: string): FlowSyntaxError => new FlowSyntaxError({ message });

/** `.toOneOf([…])`: an array of two or more side paths, in order. */
export function oneOfStepOf(branches: unknown, side: SideOf): OneOfStep {
  if (!Array.isArray(branches) || branches.length < 2)
    throw syntaxError(".toOneOf([…]) takes an array of two or more side paths: toAction(…), …");
  const paths = (branches as readonly unknown[]).map((path) => side(path, ".toOneOf([…])"));
  return { kind: StepKind.OneOf, branches: Object.freeze(paths) };
}

/** `.onFinish(F, path)`: a `@WorkflowFinish` class and the side path it takes. */
export function onFinishStepOf(finish: unknown, path: unknown, side: SideOf): OnFinishStep {
  if (typeof finish !== "function" || declarationOf(finish)?.kind !== NodeKind.Finish)
    throw syntaxError(".onFinish(F, …) takes a @WorkflowFinish class of the child workflow");
  return {
    kind: StepKind.OnFinish,
    finish: finish as Class,
    path: side(path, ".onFinish(F, …)"),
  };
}
