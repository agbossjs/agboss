import type { RuntimeGraph } from "./graph-model.js";
import { currentFrame, depthOf } from "../context/frame.js";
import { RecursionDecider, type Recursion, type RecursiveBranch } from "../analyse/recursion.js";
import type { AnswerTools } from "./answer-tools.js";

/**
 * The soft stop of a recursion (#264): on the last level an execution may run at
 * (`executionContext.depth === maxDepth`) a choice that launches `ThisWorkflow` is not offered — the
 * framework's stop, never the prompt's. An agent answers through the answer tools of its other
 * variants only, its answer checked against that narrowed schema (a second static request prefix,
 * so a second cache prefix for that level); a model router's model does not see its recursive
 * routes; a code router returning one is `RouterDecisionError`. A recursion launched by code past
 * the last level is the hard stop (`DepthLimitExceededError`, `recursion-launch.ts`).
 */

/** The branch of a node whose recursive options stop on the last level, if it has one. */
export function recursiveBranchOf(
  recursion: Recursion | undefined,
  node: string,
  decider: RecursionDecider,
): RecursiveBranch | undefined {
  return recursion?.branches.find((branch) => branch.node === node && branch.decider === decider);
}

/** Whether the current step's execution is on its workflow's last level. */
export function isLastLevel(graph: Pick<RuntimeGraph, "analysis">): boolean {
  const maxDepth = graph.analysis.recursion?.maxDepth;
  const frame = currentFrame();
  return maxDepth !== undefined && frame !== undefined && depthOf(frame.execution) >= maxDepth;
}

/** An agent's answer tools on the last level: its recursive variants left out. */
export function lastLevelAnswerTools(tools: AnswerTools, branch: RecursiveBranch): AnswerTools {
  return {
    ...tools,
    tools: tools.tools.filter((tool) => !branch.recursive.includes(tool.dto.name)),
  };
}

/**
 * The routes of a router that are not ready on the current level — hidden from a model router's
 * model, refused from a code router's `route()`; none above the last level.
 */
export function unreadyRoutesOf(
  graph: Pick<RuntimeGraph, "analysis">,
  node: string,
  decider: RecursionDecider.ModelRouter | RecursionDecider.CodeRouter,
): readonly string[] {
  const branch = recursiveBranchOf(graph.analysis.recursion, node, decider);
  return branch !== undefined && isLastLevel(graph) ? branch.recursive : [];
}
