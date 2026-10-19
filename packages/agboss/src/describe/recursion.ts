import type { FlowAnalysis } from "../flow/analyse/analyse.js";
import {
  isRouterBranch,
  lastLevelOptionsOf,
  RecursionDecider,
  type RecursiveBranch,
} from "../flow/analyse/recursion.js";

/**
 * How a recursive workflow stops (#264 AC11), as `agboss describe` prints it:
 * `recursive: ThisWorkflow, maxDepth 4, on the last level: researcher-agent → TopicReportDto only` —
 * what each branch keeps on the last level (`depth === maxDepth`): an agent's variants and a router's
 * routes that do not recurse; a choice made by code or data stops with `DepthLimitExceededError`.
 */

/** A branch's options: a router's routes as target nodes, a switch's variants as DTO classes. */
const optionText = (branch: RecursiveBranch, options: readonly string[]): string =>
  options.map((option) => (isRouterBranch(branch) ? `route(${option})` : option)).join(" | ");

function branchText(branch: RecursiveBranch): string {
  const kept = optionText(branch, lastLevelOptionsOf(branch));
  if (branch.decider !== RecursionDecider.Data) return `${branch.node} → ${kept} only`;
  const recursive = optionText(branch, branch.recursive);
  return `${branch.node} → ${recursive} fails (DepthLimitExceededError)`;
}

/** The `recursive:` line of a workflow that launches itself; none for any other. */
export function recursionLines(analysis: FlowAnalysis): readonly string[] {
  const { recursion } = analysis;
  if (recursion === undefined) return [];
  const depth =
    recursion.maxDepth === undefined ? "no maxDepth" : `maxDepth ${String(recursion.maxDepth)}`;
  const last = recursion.branches.map(branchText).join("; ");
  return [`recursive: ThisWorkflow, ${depth}${last === "" ? "" : `, on the last level: ${last}`}`];
}
