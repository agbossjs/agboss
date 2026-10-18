import { WorkflowFinishTextDto } from "../../../dto/standard/framework.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { EdgeKind, isTextAgent, type FlowNode } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * An agent without `output` answers with text (#270 AC10): it leads only to a finish whose `output`
 * is `WorkflowFinishTextDto` — `[flow.text-agent-target]` otherwise. (That it follows only a start of
 * `WorkflowStartTextDto` is its implicit `message` field, checked by `[input.missing-on-path]`.)
 */

const isTextFinish = (node: FlowNode | undefined): boolean =>
  node?.declaration.kind === NodeKind.Finish &&
  node.declaration.options.output === WorkflowFinishTextDto;

/** The edges a text agent's reply leaves by: its next step, and a launch from it (#273). */
const LEAVING: ReadonlySet<EdgeKind> = new Set([EdgeKind.Next, EdgeKind.Launch, EdgeKind.Join]);

export function textAgentRules(context: AnalysisContext): readonly RuleViolation[] {
  const { graph } = context;
  return graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    if (from === undefined || !isTextAgent(from) || !LEAVING.has(edge.kind)) return [];
    if (isTextFinish(graph.nodes.get(edge.to))) return [];
    const message =
      `${from.name} answers with text (it has no output), so it leads only to a finish with ` +
      `output: WorkflowFinishTextDto, not to ${edge.to} — give it an output, or end it there`;
    return [violation("flow.text-agent-target", message, [from.name])];
  });
}
