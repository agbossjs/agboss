import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { isValueShape, Wrapper } from "../../dto-wrappers.js";
import { WorkflowFinishTextDto } from "../../../dto/standard/framework.js";
import { EdgeKind, isTextAgent, outputOf, type FlowEdge, type FlowNode } from "../flow-graph.js";
import { shapeLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.returns(…)` is exactly where values are (#272 AC2, AC15; #270 "checked by the compiler and again
 * by assembly"): `start(S).returns(…)` gives the start's input; after a step with `output`
 * `.returns(output)` is required; after a step without one (an `@Action` done for its side effect, a
 * router) it is impossible; a `oneOf` output is written `.returns(oneOf(…))` and branched by
 * `.switch(caseOf(…)…)` (#299 S54 c, checked with the switch in `switch.ts`).
 */

/** What a start returns: its input DTO, its list, or one value per field of its map. */
function startValues(node: FlowNode): readonly string[] | undefined {
  if (node.declaration.kind !== NodeKind.Start) return undefined;
  const { input } = node.declaration.options;
  return isValueShape(input) ? [shapeLabel(input)] : Object.values(input).map(shapeLabel);
}

/** The shapes the step's edges must carry, or what to write instead of `.returns(…)`. */
function expected(node: FlowNode): readonly string[] | string {
  const fromStart = startValues(node);
  if (fromStart !== undefined) return fromStart;
  if (node.kind === NodeKind.Router) return [];
  // a text agent's reply is its implicit output (#270 AC10)
  if (isTextAgent(node)) return [shapeLabel(WorkflowFinishTextDto)];
  const output = outputOf(node);
  if (output === undefined) return [];
  if (typeof output !== "function" && output.kind === Wrapper.OneOf) {
    return `${node.name} gives ${shapeLabel(output)} — write .returns(${shapeLabel(output)}) and branch it with .switch(caseOf(…)…)`;
  }
  return [shapeLabel(output)];
}

const sorted = (labels: readonly string[]): string => [...labels].sort().join(", ");

/** The `.returns` chain that names the values: `.returns(A).returns(optional(B))` (#299 S54). */
const chain = (labels: readonly string[]): string =>
  [...labels]
    .sort()
    .map((label) => `.returns(${label})`)
    .join("");

function edgeViolation(node: FlowNode, edge: FlowEdge): RuleViolation | undefined {
  if (edge.kind === EdgeKind.Case || edge.kind === EdgeKind.Error) return undefined;
  const want = expected(node);
  const got = edge.writes.map((write) => shapeLabel(write.shape));
  if (typeof want === "string") return violation("flow.returns-mismatch", want, [node.name]);
  if (sorted(want) === sorted(got)) return undefined;
  const message =
    want.length === 0
      ? `${node.name} has no output — remove ${chain(got)} after it`
      : `${node.name} gives ${sorted(want)} — write ${chain(want)} after it` +
        (got.length === 0 ? "" : `, not ${chain(got)}`);
  return violation("flow.returns-mismatch", message, [node.name]);
}

export function returnsRules(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const edge of context.graph.edges) {
    const node = context.graph.nodes.get(edge.from);
    const problem = node === undefined ? undefined : edgeViolation(node, edge);
    if (problem !== undefined) found.set(problem.message, problem);
  }
  return [...found.values()];
}
