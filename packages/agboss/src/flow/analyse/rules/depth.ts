import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { PathSource } from "../../ast.js";
import { pathLabel } from "../labels.js";
import type { Placement } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[flow.path-too-deep]` (#272 AC10): nesting is counted inside each path, reset at every path start;
 * each `toOneOf` branch, `onRoute` route and `onError` side path is one level. More levels than
 * `executionLimits.maxPathDepth` (4) is a warning — an error under `--strict`. One per path, at its
 * deepest node (the deepest, then the first by name: the same whatever the order of branches).
 */

/** The default of `executionLimits.maxPathDepth`. */
export const DEFAULT_MAX_PATH_DEPTH = 4;

const deeper = (first: Placement, second: Placement): Placement =>
  second.depth > first.depth || (second.depth === first.depth && second.node < first.node)
    ? second
    : first;

export function depthRules(context: AnalysisContext): readonly RuleViolation[] {
  const limit = context.workflow.executionLimits?.maxPathDepth ?? DEFAULT_MAX_PATH_DEPTH;
  const deepest = new Map<PathSource, Placement>();
  for (const placement of context.walked.placements) {
    const found = deepest.get(placement.path);
    deepest.set(placement.path, found === undefined ? placement : deeper(found, placement));
  }
  return [...deepest.values()]
    .filter((placement) => placement.depth > limit)
    .map((placement) => {
      const message =
        `${context.workflow.name}: the path ${pathLabel(placement.path)} nests ${String(placement.depth)} ` +
        `levels at ${placement.node} (limit ${String(limit)}) — move the branch into a child ` +
        "workflow (agboss generate workflow …)";
      return violation("flow.path-too-deep", message, [placement.node]);
    });
}
