import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { declarationOf } from "../../decorators/declaration.js";
import { declaredExecutionLimitsOf, DEFAULT_MAX_CONCURRENCY } from "../../decorators/workflow.js";
import { childClassesOf } from "../child-workflow.js";
import { classLabel } from "../labels.js";
import {
  isRouterBranch,
  lastLevelOptionsOf,
  type Recursion,
  type RecursiveBranch,
} from "../recursion.js";
import type { AnalysisContext } from "./context.js";

/**
 * The recursion rules (#264 PR 1) and the tree's cap (#264 PR 2, below): a workflow that can launch itself (`toWorkflow(() => Self)`, #1287) sets `@Workflow({ executionLimits: { maxDepth } })`,
 * a positive whole number (`[graph.recursion-without-depth]`); every branch with a recursive option
 * keeps one that is not, so the last level can still end (`[graph.recursion-without-exit]`); and a
 * workflow never launches a child that launches it again
 * (`[graph.mutual-recursion]` — only direct recursion, a workflow launching itself, is supported).
 */

const isPositiveWhole = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 1;

function depthViolations(context: AnalysisContext, recursion: Recursion): RuleViolation[] {
  const { maxDepth } = recursion;
  if (isPositiveWhole(maxDepth)) return [];
  const what =
    maxDepth === undefined
      ? "it launches itself but sets no executionLimits.maxDepth"
      : `its executionLimits.maxDepth is ${String(maxDepth)}, not a whole number of levels from 1`;
  const message =
    `${what} — a recursive workflow bounds its levels: @Workflow({ executionLimits: { maxDepth: 4 } }) allows ` +
    "executions at depth 1 (the root) to 4";
  return [violation("graph.recursion-without-depth", message, [context.workflow.name])];
}

const optionLabel = (branch: RecursiveBranch, option: string): string =>
  isRouterBranch(branch) ? `.onRoute(${option})` : `.toOneOf([…]) branch ${option}`;

function exitViolations(recursion: Recursion): RuleViolation[] {
  return recursion.branches
    .filter((branch) => lastLevelOptionsOf(branch).length === 0)
    .map((branch) => {
      const options = branch.recursive.map((option) => optionLabel(branch, option)).join(", ");
      const message =
        `${branch.node}: every way on (${options}) launches the workflow itself — on the last level ` +
        "(depth === maxDepth) none is left; add a branch or a route that does not recurse";
      return violation("graph.recursion-without-exit", message, [branch.node]);
    });
}

/** The chain of child workflows from `from` back to `self`, if any (depth first); a class that is no workflow has none. */
function chainBack(from: Class, self: Class, seen: Set<Class>): readonly Class[] | undefined {
  if (from === self) return [from];
  if (seen.has(from)) return undefined;
  seen.add(from);
  const declaration = declarationOf(from);
  // Stryker disable next-line OptionalChaining: equivalent: `childClassesOf` lists only classes that are workflows, so a declaration is always there; the check stays for a class that is not one
  switch (declaration?.kind) {
    case NodeKind.Workflow:
      for (const child of childClassesOf(declaration.options.flow, from)) {
        const chain = chainBack(child, self, seen);
        if (chain !== undefined) return [from, ...chain];
      }
      return undefined;
    // Stryker disable next-line ConditionalExpression: equivalent: with no default the switch ends the same way, in the `undefined` the function returns
    default:
      return undefined;
  }
}

const nameOf = (workflow: Class): string =>
  // Stryker disable next-line OptionalChaining: equivalent: the classes named are workflows (`chainBack` lists no other), so a declaration is always there; the label stays for a class that is not one
  declarationOf(workflow)?.options.name ?? classLabel(workflow);

function mutualViolations(context: AnalysisContext, self: Class): RuleViolation[] {
  const name = context.workflow.name;
  return childClassesOf(context.workflow.flow, self).flatMap((child) => {
    const chain = chainBack(child, self, new Set());
    if (chain === undefined) return [];
    const message =
      `${[name, ...chain.map(nameOf)].join(" → ")}: mutual recursion is not supported — ` +
      "a workflow launches only itself (toWorkflow(() => ItsOwnClass)); merge the two into one recursive workflow";
    return [violation("graph.mutual-recursion", message, [name, nameOf(child)])];
  });
}

/** The recursion rules of a workflow (`self` is its class). */
export function recursionRules(
  context: AnalysisContext,
  self: Class,
  recursion: Recursion | undefined,
): readonly RuleViolation[] {
  const own =
    recursion === undefined
      ? []
      : [...depthViolations(context, recursion), ...exitViolations(recursion)];
  return [...own, ...mutualViolations(context, self)];
}

/**
 * The tree's concurrency cap (#264): `@Workflow({ executionLimits: { maxConcurrency } })` is a whole number of
 * executions from 1 (`[limits.max-concurrent-executions-invalid]`, an error: 0 would stop the tree);
 * a child workflow's own value limits its subtree and cannot exceed its parent's — a larger one is
 * never reached, so it is a warning (`[limits.child-concurrency-above-parent]`, an error under
 * `--strict`).
 */

/** The error of a workflow whose `executionLimits.maxConcurrency` is not a whole number from 1. */
export function concurrencyErrors(context: AnalysisContext): readonly RuleViolation[] {
  const value = context.workflow.executionLimits?.maxConcurrency;
  if (value === undefined || isPositiveWhole(value)) return [];
  const message =
    `its executionLimits.maxConcurrency is ${String(value)}, not a whole number of executions from 1 — ` +
    "@Workflow({ executionLimits: { maxConcurrency: 6 } }) lets six executions of the tree work at once";
  return [violation("limits.max-concurrent-executions-invalid", message, [context.workflow.name])];
}

/** The warnings of the workflow's children whose own cap is above the workflow's. */
export function concurrencyWarnings(context: AnalysisContext): readonly RuleViolation[] {
  const own = context.workflow.executionLimits?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const limitsOf = context.options.limits ?? declaredExecutionLimitsOf;
  return childClassesOf(context.workflow.flow).flatMap((child) => {
    const childCap = limitsOf(child).maxConcurrency;
    if (childCap === undefined || childCap <= own) return [];
    const message =
      `${nameOf(child)} sets executionLimits.maxConcurrency ${String(childCap)}, above its parent's ` +
      `${String(own)} — a child's cap limits its subtree inside its parent's tree, so it never ` +
      `goes above ${String(own)}; lower it, or raise the parent's`;
    return [violation("limits.child-concurrency-above-parent", message, [context.workflow.name])];
  });
}
