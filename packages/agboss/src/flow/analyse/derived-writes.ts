import { ComponentKind } from "../runtime/records.js";
import { WorkflowFinishTextDto } from "../../dto/standard/framework.js";
import { isValueShape, Wrapper, type ValueShape } from "../dto-wrappers.js";
import { withSlices } from "./slices.js";
import { isTextAgent, outputOf, valueWrite, type FlowNode, type ValueWrite } from "./flow-graph.js";

/**
 * What a step gives, read from its own declaration (#1270): a start its `input` (one value, or one
 * per field of its map), an agent, action, question role or child workflow its `output`, a text
 * agent its reply as `WorkflowFinishTextDto` (#270 AC10). A router and a step without `output` give
 * nothing; a `oneOf(…)` output gives nothing itself — each case of its `.toOneOf([…])` writes its class.
 */

/** The values a start gives: its input DTO or list, or one value per field of its map. */
function startShapes(node: FlowNode): readonly ValueShape[] | undefined {
  if (node.declaration.kind !== ComponentKind.WorkflowStart) return undefined;
  const { input } = node.declaration.options;
  return isValueShape(input) ? [input] : Object.values(input);
}

/** The values a node writes on its way out. */
export function derivedWrites(node: FlowNode): readonly ValueWrite[] {
  const fromStart = startShapes(node);
  if (fromStart !== undefined) return fromStart.map((shape) => valueWrite(shape, false));
  if (node.kind === ComponentKind.Router) return [];
  if (isTextAgent(node)) return [valueWrite(WorkflowFinishTextDto, false)];
  const output = outputOf(node);
  if (output === undefined) return [];
  if (typeof output !== "function" && output.kind === Wrapper.OneOf) return [];
  return withSlices([valueWrite(output, false)]);
}
