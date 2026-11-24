import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind, type OneOfStep, type OnFinishStep, type Step } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import type { ComponentName } from "../registry.js";
import { EdgeKind, outputOf, valueWrite } from "./flow-graph.js";
import type { NodeTable } from "./nodes.js";
import { resolveOneOf } from "./one-of.js";
import { variantsOf } from "./rules/one-of.js";
import type { Cursor } from "./walk-cursor.js";
import type { BranchSite, OneOfSite } from "./walked-flow.js";

/**
 * How the walk reads the branches that name no DTO (#1275): `.toOneOf([…])` — each branch enters
 * with the variant its entry consumer reads — and `.onFinish(F, …)`, which enters with the output
 * of the child's finish it names, picked by the finish's component name.
 */

/** What the walker keeps for these steps. */
export interface BranchRecorder {
  readonly table: NodeTable;
  readonly oneOfs: OneOfSite[];
  readonly onFinishes: BranchSite<OnFinishStep>[];
  readonly violations: RuleViolation[];
}

/** Walks a step list from a cursor; whether it reached a node of its own (a `.to…` step). */
export type WalkSteps = (steps: readonly Step[], cursor: Cursor) => boolean;

/** A branch's walk from a cursor that has the value the branch takes written. */
function enterBranch(
  recorder: BranchRecorder,
  steps: readonly Step[],
  inner: Cursor,
  walkSteps: WalkSteps,
  label: string,
): void {
  if (walkSteps(steps, inner) || inner.current === undefined) return;
  const message = `${inner.current}: ${label} leads nowhere — continue it with .to…(…)`;
  recorder.violations.push(violation("graph.dead-end", message, [inner.current]));
}

/** The cursor a branch starts at: the step before it, with the value the branch takes. */
const branchCursor = (cursor: Cursor, current: ComponentName, take: Partial<Cursor>): Cursor => ({
  current,
  writes: [],
  entry: EdgeKind.Case,
  path: cursor.path,
  depth: cursor.depth + 1,
  ...take,
});

/** `.toOneOf([…])` (#1275): each branch enters with the variant its entry consumer reads. */
export function walkOneOf(
  recorder: BranchRecorder,
  step: OneOfStep,
  cursor: Cursor,
  walkSteps: WalkSteps,
): void {
  const { current } = cursor;
  if (current === undefined) return;
  const resolution = resolveOneOf(variantsOf(outputOf(recorder.table.node(current))), step);
  recorder.oneOfs.push({ node: current, step, resolution });
  step.branches.forEach((branch, index) => {
    const variant = resolution.variants[index];
    const take =
      variant === undefined ? {} : { writes: [valueWrite(variant, true)], caseKey: variant.name };
    const inner = branchCursor(cursor, current, take);
    enterBranch(recorder, branch.steps, inner, walkSteps, "a .toOneOf([…]) branch");
  });
}

/** `.onFinish(F, …)` (#1275b): one finish of the child workflow the cursor stands at. */
export function walkOnFinish(
  recorder: BranchRecorder,
  step: OnFinishStep,
  cursor: Cursor,
  walkSteps: WalkSteps,
): void {
  const { current } = cursor;
  if (current === undefined) return;
  recorder.onFinishes.push({ node: current, step });
  const declaration = declarationOf(step.finish);
  const finish = declaration?.kind === NodeKind.Finish ? declaration.options : undefined;
  const take =
    finish === undefined ? {} : { writes: [valueWrite(finish.output, true)], caseKey: finish.name };
  const inner = branchCursor(cursor, current, take);
  enterBranch(recorder, step.path.steps, inner, walkSteps, `.onFinish(${step.finish.name}, …)`);
}
