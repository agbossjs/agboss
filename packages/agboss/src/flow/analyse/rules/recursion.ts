import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { declarationOf } from "../../decorators/declaration.js";
import {
  declaredMaxConcurrentExecutionsOf,
  DEFAULT_MAX_CONCURRENT_EXECUTIONS,
} from "../../decorators/workflow.js";
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
 * The recursion rules (#264 PR 1) and the tree's cap (#264 PR 2, below): a workflow that can reach `ThisWorkflow` sets `@Workflow({ maxDepth })`,
 * a positive whole number (`[graph.recursion-without-depth]`); every branch with a recursive option
 * keeps one that is not, so the last level can still end (`[graph.recursion-without-exit]`); and a
 * workflow never launches a child that launches it again, nor names its own class
 * (`[graph.mutual-recursion]` — only direct recursion, through `ThisWorkflow`, is supported).
 */

const isPositiveWhole = (value: number): boolean => Number.isInteger(value) && value >= 1;

function depthViolations(context: AnalysisContext, recursion: Recursion): RuleViolation[] {
  const { maxDepth } = recursion;
  if (maxDepth !== undefined && isPositiveWhole(maxDepth)) return [];
  const what =
    maxDepth === undefined
      ? "it launches ThisWorkflow but sets no maxDepth"
      : `its maxDepth is ${String(maxDepth)}, not a whole number of levels from 1`;
  const message =
    `${what} — a recursive workflow bounds its levels: @Workflow({ maxDepth: 4 }) allows ` +
    "executions at depth 1 (the root) to 4";
  return [violation("graph.recursion-without-depth", message, [context.workflow.name])];
}

const optionLabel = (branch: RecursiveBranch, option: string): string =>
  isRouterBranch(branch) ? `route(${option})` : `caseOf(${option})`;

function exitViolations(recursion: Recursion): RuleViolation[] {
  return recursion.branches
    .filter((branch) => lastLevelOptionsOf(branch).length === 0)
    .map((branch) => {
      const options = branch.recursive.map((option) => optionLabel(branch, option)).join(", ");
      const message =
        `${branch.node}: every way on (${options}) launches ThisWorkflow — on the last level ` +
        "(depth === maxDepth) none is left; add a caseOf(…) or route(…) that does not recurse";
      return violation("graph.recursion-without-exit", message, [branch.node]);
    });
}

/** The chain of child workflows from `from` back to `self`, if any (depth first). */
function chainBack(from: Class, self: Class, seen: Set<Class>): readonly Class[] | undefined {
  if (from === self) return [from];
  if (seen.has(from)) return undefined;
  seen.add(from);
  const declaration = declarationOf(from);
  if (declaration?.kind !== NodeKind.Workflow) return undefined;
  for (const child of childClassesOf(declaration.options.flow)) {
    const chain = chainBack(child, self, seen);
    if (chain !== undefined) return [from, ...chain];
  }
  return undefined;
}

const nameOf = (workflow: Class): string => {
  const declaration = declarationOf(workflow);
  return declaration === undefined ? classLabel(workflow) : declaration.options.name;
};

function mutualViolations(context: AnalysisContext, self: Class): RuleViolation[] {
  const name = context.workflow.name;
  return childClassesOf(context.workflow.flow).flatMap((child) => {
    const chain = chainBack(child, self, new Set());
    if (chain === undefined) return [];
    const message =
      child === self
        ? `its flow names its own class (${classLabel(self)}) — a workflow launches itself with ThisWorkflow`
        : `${[name, ...chain.map(nameOf)].join(" → ")}: mutual recursion is not supported — ` +
          "a workflow launches only itself (ThisWorkflow); merge the two into one recursive workflow";
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
 * The tree's concurrency cap (#264): `@Workflow({ maxConcurrentExecutions })` is a whole number of
 * executions from 1 (`[limits.max-concurrent-executions-invalid]`, an error: 0 would stop the tree);
 * a child workflow's own value limits its subtree and cannot exceed its parent's — a larger one is
 * never reached, so it is a warning (`[limits.child-concurrency-above-parent]`, an error under
 * `--strict`).
 */

/** The error of a workflow whose `maxConcurrentExecutions` is not a whole number from 1. */
export function concurrencyErrors(context: AnalysisContext): readonly RuleViolation[] {
  const value = context.workflow.maxConcurrentExecutions;
  if (value === undefined || isPositiveWhole(value)) return [];
  const message =
    `its maxConcurrentExecutions is ${String(value)}, not a whole number of executions from 1 — ` +
    "@Workflow({ maxConcurrentExecutions: 6 }) lets six executions of the tree work at once";
  return [violation("limits.max-concurrent-executions-invalid", message, [context.workflow.name])];
}

/** The warnings of the workflow's children whose own cap is above the workflow's. */
export function concurrencyWarnings(context: AnalysisContext): readonly RuleViolation[] {
  const own = context.workflow.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  return childClassesOf(context.workflow.flow).flatMap((child) => {
    const childCap = declaredMaxConcurrentExecutionsOf(child);
    if (childCap === undefined || childCap <= own) return [];
    const message =
      `${nameOf(child)} sets maxConcurrentExecutions ${String(childCap)}, above its parent's ` +
      `${String(own)} — a child's cap limits its subtree inside its parent's tree, so it never ` +
      `goes above ${String(own)}; lower it, or raise the parent's`;
    return [violation("limits.child-concurrency-above-parent", message, [context.workflow.name])];
  });
}
