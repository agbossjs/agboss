import { WorkflowStartTextDto } from "../../dto/standard/framework.js";
import { NodeKind } from "../ast.js";
import type { InputFieldShape, InputFields } from "../decorators/declaration.js";
import type { ComponentName } from "../registry.js";
import { childFieldsOf, type ChildEntry } from "./children.js";
import type { FlowGraph, FlowNode } from "./flow-graph.js";
import { shapeLabel } from "./labels.js";
import { slotOfField, type SlotKey } from "./scope.js";

/**
 * Which slot each input field reads (#270): the slot of its shape — the latest value of its class
 * or list. A `historyOf(XDto)` field reads the current `XDto` and, at run time, its earlier
 * versions (#299 S56). A finish without `input` reads the latest value of its `output` type (Q50).
 * A child workflow (#263) reads the fields of the starts its edges enter through (`children.ts`).
 */

export interface ResolvedField {
  /** The field name; for a pass-through finish, the name of its output DTO. */
  readonly name: string;
  /** How messages name it: `answer-agent.message (WorkflowStartTextDto)`. */
  readonly label: string;
  readonly shape: InputFieldShape;
  /** The slot it reads: its shape's own slot. */
  readonly slot: SlotKey;
  readonly isRequired: boolean;
  readonly isList: boolean;
  /** `historyOf(XDto, { limit })`: it reads the earlier versions too (#299 S56). */
  readonly history?: { readonly limit?: number };
  /** The output of a finish without `input`: not a field of `InputOf<X>`. */
  readonly isPassThrough: boolean;
}

/** What a text agent (no `input`, #270 AC10) reads: the latest `WorkflowStartTextDto`. */
export const TEXT_AGENT_INPUT: InputFields = Object.freeze({ message: WorkflowStartTextDto });

/** The fields a node reads from the path scope, as declared (a text agent's implicit `message`). */
function declaredFields(node: FlowNode): InputFields | undefined {
  const { declaration } = node;
  switch (declaration.kind) {
    case NodeKind.Agent:
      return declaration.options.input ?? TEXT_AGENT_INPUT;
    case NodeKind.Action:
    case NodeKind.Router:
    case NodeKind.Finish:
      return declaration.options.input;
    default:
      return undefined;
  }
}

function resolveField(node: FlowNode, name: string, shape: InputFieldShape): ResolvedField {
  const slot = slotOfField(shape);
  const label = `${node.name}.${name} (${shapeLabel(shape)})`;
  return { name, label, shape, ...slot, isPassThrough: false };
}

/** A pass-through finish reads the latest value of its `output` type. */
function passThroughField(node: FlowNode): ResolvedField | undefined {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Finish || declaration.options.input !== undefined)
    return undefined;
  const { output } = declaration.options;
  const { slot } = slotOfField(output);
  const label = `${node.name} (${shapeLabel(output)})`;
  return {
    name: output.name,
    label,
    shape: output,
    slot,
    isRequired: true,
    isList: false,
    isPassThrough: true,
  };
}

/** The resolved fields of every node that reads the path scope. */
export function resolveFields(
  graph: FlowGraph,
  children: readonly ChildEntry[] = [],
): ReadonlyMap<ComponentName, readonly ResolvedField[]> {
  const byNode = new Map<ComponentName, readonly ResolvedField[]>();
  for (const node of graph.nodes.values()) {
    if (node.kind === NodeKind.Workflow) {
      byNode.set(node.name, childFieldsOf(children, node.name));
      continue;
    }
    const passThrough = passThroughField(node);
    if (passThrough !== undefined) {
      byNode.set(node.name, [passThrough]);
      continue;
    }
    const fields = declaredFields(node);
    if (fields === undefined) continue;
    byNode.set(
      node.name,
      Object.entries(fields).map(([name, shape]) => resolveField(node, name, shape)),
    );
  }
  return byNode;
}
