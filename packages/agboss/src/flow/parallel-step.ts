import { ConfigError } from "../core/error-families/config-errors.js";
import {
  NodeKind,
  StepKind,
  type ErrorClass,
  type ForEachItemStep,
  type InParallelStep,
  type ParallelBranchStep,
  type ParallelTargetKind,
  type Step,
  type SubPath,
  type ToStep,
} from "./ast.js";

/**
 * The parallel steps of the path builder (#1279, #1280): `.inParallel([toAgent(A), toAction(X)…],
 * { maxConcurrency })` launches branches of any kind at once and `.forEachItem(toAgent(A), { maxItems
 * | takeFirst, maxConcurrency })` runs one step per item of the list before it; both are followed by
 * `.join()`. A branch is a side path of one step, `.onError(E, skip())` after it drops its failure
 * from the join. The typed builder makes the wrong forms compile errors; these checks hold for
 * untyped code.
 */

const SKIP = Symbol("skip");

/** What `skip()` gives: a marker `.onError(E, skip())` takes in place of a side path. */
export interface Skip {
  readonly [SKIP]: true;
}

const MARKER: Skip = Object.freeze({ [SKIP]: true as const });

/**
 * `.onError(StepError, skip())` on a branch of `.inParallel([…])` or `.forEachItem(…)` (#1279): a
 * failure of that class drops the branch out of the join — its place is empty (`optional(…)` in the
 * scope) and the launch goes on. A limit or a cancellation is never skipped.
 */
export const skip = (): Skip => MARKER;

/** Whether `value` is what `skip()` gives. */
export const isSkip = (value: unknown): value is Skip =>
  typeof value === "object" && value !== null && Reflect.get(value, SKIP) === true;

const syntaxError = (message: string): ConfigError.FlowSyntax =>
  new ConfigError.FlowSyntax({ message });

const PARALLEL_KINDS: readonly NodeKind[] = [
  NodeKind.Agent,
  NodeKind.Action,
  NodeKind.Workflow,
  NodeKind.Question,
  NodeKind.Router,
];

const isParallelKind = (kind: NodeKind): kind is ParallelTargetKind =>
  PARALLEL_KINDS.includes(kind);

/** How the builder turns what it was given into a branch's path (a side path), or throws. */
export type BranchOf = (value: unknown, call: string) => SubPath;

/** A step only a branch of `.inParallel([…])` may carry: with an `.onError(E, skip())` or a `chooseMany([…])` (#1279). */
export const isBranchOnly = (step: Step): boolean =>
  step.kind === StepKind.To && (step.skip !== undefined || step.chooses !== undefined);

/**
 * `toRouter(R).chooseMany([…branches])` (#1279b): `last`, the router's step, with the branches it
 * picks among. Only a sub-path's router has them; each branch is one step of a kind a launch runs.
 */
export function chosenStepOf(
  { last, isSubPath }: BranchSite,
  branches: unknown,
  branchOf: BranchOf,
): ToStep {
  const call = ".chooseMany([…])";
  if (!isSubPath || last?.kind !== StepKind.To || last.targetKind !== NodeKind.Router)
    throw syntaxError(`${call} stands right after toRouter(R), in a branch of .inParallel([…])`);
  if (last.skip !== undefined || last.chooses !== undefined)
    throw syntaxError(`${call} stands once, right after toRouter(R)`);
  if (!Array.isArray(branches))
    throw syntaxError(`${call} takes an array of branches: toAgent(…), toAction(…), …`);
  const chosen = (branches as readonly unknown[]).map((branch) =>
    parallelBranchOf(branch, call, branchOf),
  );
  if (chosen.some((branch) => branch.targetKind === NodeKind.Router))
    throw syntaxError(`${call}: a router is no branch of a router's choice`);
  return { ...last, chooses: Object.freeze(chosen) };
}

/** Whether a builder with this source and start is a side path (a branch is one). */
export const isSidePath = (source: unknown, start: { readonly kind: string }): boolean =>
  source === undefined && start.kind === "side";

/** Where a builder stands: its last step, and whether it is a side path (a branch is one). */
export interface BranchSite {
  readonly last: Step | undefined;
  readonly isSubPath: boolean;
}

/**
 * `.onError(E, skip())` right after the step of a branch: `last` with `error` among its skips. Only
 * a sub-path's builder may carry one; `.inParallel([…])` and `.forEachItem(…)` read it.
 */
export function skippedStepOf({ last, isSubPath }: BranchSite, error: ErrorClass): ToStep {
  if (!isSubPath || last?.kind !== StepKind.To)
    throw syntaxError(
      ".onError(E, skip()) stands right after the step of a branch of .inParallel([…]) or .forEachItem(…): toAgent(A).onError(E, skip())",
    );
  return { ...last, skip: Object.freeze([...(last.skip ?? []), error]) };
}

/** Why the one step of a branch cannot be one, when it cannot. */
function stepProblem(step: ToStep): string | undefined {
  if ((step.targetKind === NodeKind.Router) !== (step.chooses !== undefined))
    return "a router is a branch as toRouter(R).chooseMany([…]), and only a router has chooseMany";
  return step.chooses !== undefined && step.skip !== undefined
    ? "a router's choice takes no skip()"
    : undefined;
}

/** One branch: a path of exactly one entering step — `toAgent(A)`, `toAction(X)`, `toExternalTask(Q)`, `toWorkflow(W)`. */
export function parallelBranchOf(
  value: unknown,
  call: string,
  branchOf: BranchOf,
): ParallelBranchStep {
  const [first, ...rest] = branchOf(value, call).steps;
  if (first?.kind !== StepKind.To || rest.length > 0 || !isParallelKind(first.targetKind))
    throw syntaxError(
      `${call} takes branches of one step: toAgent(…), toAction(…), toExternalTask(…) or toWorkflow(…)`,
    );
  const problem = stepProblem(first);
  if (problem !== undefined) throw syntaxError(`${call}: ${problem}`);
  const { targetKind } = first;
  // a child workflow's thunk stays unread until the flow is analysed (#1287)
  const branch = {
    targetKind,
    skip: Object.freeze([...(first.skip ?? [])]),
    ...(first.chooses === undefined ? {} : { chooses: first.chooses }),
  };
  return Object.freeze(
    Object.defineProperty(branch, "target", { enumerable: true, get: () => first.target }),
  ) as ParallelBranchStep;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

function limitOf(options: object, key: string, call: string): number | undefined {
  const value: unknown = Reflect.get(options, key);
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value))
    throw syntaxError(`${call}(…, { ${key} }) takes a positive integer`);
  return value;
}

function optionsOf(options: unknown, call: string): object {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null)
    throw syntaxError(`${call}(…) takes its options as an object`);
  return options;
}

/** `.inParallel([…branches], { maxConcurrency })`. */
export function inParallelStepOf(
  branches: unknown,
  options: unknown,
  branchOf: BranchOf,
): InParallelStep {
  const call = ".inParallel([…])";
  if (!Array.isArray(branches) || branches.length === 0)
    throw syntaxError(`${call} takes an array of one or more branches: toAgent(…), toAction(…), …`);
  const given = optionsOf(options, ".inParallel");
  const unknownKey = Object.keys(given).find((key) => key !== "maxConcurrency");
  if (unknownKey !== undefined)
    throw syntaxError(`.inParallel([…], { ${unknownKey} }) takes { maxConcurrency } only`);
  const maxConcurrency = limitOf(given, "maxConcurrency", ".inParallel");
  return Object.freeze({
    kind: StepKind.InParallel as const,
    branches: Object.freeze(
      (branches as readonly unknown[]).map((branch) => parallelBranchOf(branch, call, branchOf)),
    ),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  });
}

/** `.forEachItem(step, { maxItems | takeFirst, maxConcurrency })`. */
export function forEachItemStepOf(
  step: unknown,
  options: unknown,
  branchOf: BranchOf,
): ForEachItemStep {
  const call = ".forEachItem(step, …)";
  const branch = parallelBranchOf(step, call, branchOf);
  const given = optionsOf(options, ".forEachItem");
  const unknownKey = Object.keys(given).find(
    (key) => !["maxItems", "takeFirst", "maxConcurrency"].includes(key),
  );
  if (unknownKey !== undefined)
    throw syntaxError(
      `.forEachItem(step, { ${unknownKey} }) takes { maxItems | takeFirst, maxConcurrency }`,
    );
  const maxItems = limitOf(given, "maxItems", ".forEachItem");
  const takeFirst = limitOf(given, "takeFirst", ".forEachItem");
  if ((maxItems === undefined) === (takeFirst === undefined))
    throw syntaxError(
      ".forEachItem(step, { maxItems } | { takeFirst }) takes exactly one of them: maxItems throws LimitError.Items past it, takeFirst slices",
    );
  const maxConcurrency = limitOf(given, "maxConcurrency", ".forEachItem");
  return Object.freeze({
    kind: StepKind.ForEachItem as const,
    branch,
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(takeFirst === undefined ? {} : { takeFirst }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  });
}
