import { STEPS_PER_WORKING_NODE } from "../../graph/limits.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import type { FlowNode } from "./flow-graph.js";
import type { AnalysisContext } from "./rules/context.js";
import { maxStepsOf, mostStepsFrom } from "./steps.js";

/** What 0.1.0 counted: agents and routers only. */
const isOldStep = (node: FlowNode | undefined): boolean =>
  node?.kind === NodeKind.Agent || node?.kind === NodeKind.Router;

/**
 * `[limits.max-steps-above-0.1.0-default]` (#1278, D8): a flow without a `maxSteps` whose worst
 * case takes more steps than 0.1.0's default — (agents + routers) × 3 — allowed. Actions and
 * external tasks count now and the default grew with them; a flow that depended on them not
 * counting runs past what it ran under before, so the author sees it and may set `maxSteps`.
 */
export function stepsAboveOldDefaultWarnings(context: AnalysisContext): readonly RuleViolation[] {
  const { graph } = context;
  if (context.workflow.maxSteps !== undefined) return [];
  const old = [...graph.nodes.values()].filter(isOldStep).length * STEPS_PER_WORKING_NODE;
  // no agent or router: 0.1.0's steps were always 0, there is nothing counted differently to tell
  if (old === 0) return [];
  return graph.starts.flatMap((start) => {
    const most = mostStepsFrom(graph, start);
    if (most === undefined || most <= old) return [];
    const message =
      `the worst case from ${start} takes ${String(most)} steps, more than the ${String(old)} that 0.1.0's default ` +
      `maxSteps — (agents + routers) × ${String(STEPS_PER_WORKING_NODE)} — allowed: actions and external tasks ` +
      `count as steps now, and the default is ${String(maxStepsOf(graph, undefined))}. Set @Workflow({ maxSteps }) to choose the bound`;
    return [violation("limits.max-steps-above-0.1.0-default", message, [start])];
  });
}
