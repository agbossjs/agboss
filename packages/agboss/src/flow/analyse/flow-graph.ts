import type { Class } from "../../components/injection.js";
import { WorkflowFinishTextDto } from "../../dto/standard/framework.js";
import { NodeKind, type ErrorClass } from "../ast.js";
import type { ComponentDeclaration } from "../decorators/declaration.js";
import type { DtoClass } from "../../dto/types.js";
import type { OutputShape, ValueShape } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import { dtoLabel, shapeLabel } from "./labels.js";

/**
 * The graph of a v2 workflow as the analyser sees it (#272 PR 2): one node per component `name`
 * (one class = one node), one edge per transition. What a step returns travels on its outgoing
 * edge (`writes`), so a node reads its `input` from the scopes that reach it and writes nothing
 * itself. Nodes and edges are kept in a canonical order: reordering paths, routes or cases does not
 * change the graph (AC9).
 */

/** How an edge was written in the flow. */
export enum EdgeKind {
  /** `.to…(X)` after a step (and its `.returns(…)`). */
  Next = "next",
  /** `caseOf(XDto)…` of a `.switch(…)`: the variant enters the scope on this edge. */
  Case = "case",
  /** `route(X)` of a `.chooseOne(…)`. */
  Route = "route",
  /** `.onError(E, toAction(X)…)`: the step failed, so it wrote nothing. */
  Error = "error",
}

/**
 * One value an edge puts into the path scope: a `.returns(…)` value or a `caseOf(…)` variant (a
 * `.returns(oneOf(…))` writes nothing itself: each case writes its class).
 */
export interface ValueWrite {
  readonly shape: ValueShape;
  /** `{ about }` of its `.returns` or `caseOf` (#299 S54): what the value is about. */
  readonly about?: readonly DtoClass[];
  /** Written by `caseOf(XDto)`: the switch read it to choose the branch (#270 AC19). */
  readonly isCase: boolean;
}

export interface FlowEdge {
  readonly from: ComponentName;
  readonly to: ComponentName;
  readonly kind: EdgeKind;
  readonly writes: readonly ValueWrite[];
  /** The class an `EdgeKind.Error` edge catches. */
  readonly error?: ErrorClass;
}

/** A node of the graph: a decorated component and what its decorator recorded. */
export interface FlowNode {
  readonly name: ComponentName;
  readonly kind: NodeKind;
  readonly component: Class;
  readonly declaration: ComponentDeclaration;
}

export interface FlowGraph {
  /** By `name`, sorted. */
  readonly nodes: ReadonlyMap<ComponentName, FlowNode>;
  /** Sorted by `edgeKey`. */
  readonly edges: readonly FlowEdge[];
  /** The workflow starts, sorted by name. */
  readonly starts: readonly ComponentName[];
}

/** The `output` shape of a node, when it declares one. */
export function outputOf(node: FlowNode): OutputShape | undefined {
  const { declaration } = node;
  switch (declaration.kind) {
    case NodeKind.Agent:
    case NodeKind.Action:
    case NodeKind.Finish:
      return declaration.options.output;
    default:
      return undefined;
  }
}

/** An agent without `output` answers with text (#270 AC10). */
export const isTextAgent = (node: FlowNode): boolean =>
  node.declaration.kind === NodeKind.Agent && node.declaration.options.output === undefined;

/** What a text agent gives on its way out: its reply as `WorkflowFinishTextDto`. */
const TEXT_ANSWER: readonly ValueWrite[] = [{ shape: WorkflowFinishTextDto, isCase: false }];

/** What an edge of `kind` leaving `node` writes: the flow's values, or a text agent's reply. */
export const writesLeaving = (
  node: FlowNode,
  kind: EdgeKind,
  written: readonly ValueWrite[],
): readonly ValueWrite[] => (isTextAgent(node) && kind === EdgeKind.Next ? TEXT_ANSWER : written);

/** A canonical, comparable key of an edge. */
export function edgeKey(edge: FlowEdge): string {
  const writes = edge.writes.map(
    (write) =>
      `${shapeLabel(write.shape)}@${(write.about ?? []).map(dtoLabel).join("+")}:${String(write.isCase)}`,
  );
  return [edge.from, edge.to, edge.kind, edge.error?.name ?? "", writes.join(",")].join("|");
}

/** Edges leaving each node, in canonical order. */
export function outgoingEdges(graph: FlowGraph): ReadonlyMap<ComponentName, readonly FlowEdge[]> {
  const byNode = new Map<ComponentName, FlowEdge[]>();
  for (const edge of graph.edges) byNode.set(edge.from, [...(byNode.get(edge.from) ?? []), edge]);
  return byNode;
}

/** Every node reachable from `from` (included) over `edges`. */
export function reachableFrom(
  from: readonly ComponentName[],
  edges: readonly FlowEdge[],
): ReadonlySet<ComponentName> {
  const seen = new Set<ComponentName>(from);
  const queue: ComponentName[] = [...from];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const edge of edges) {
      if (edge.from !== node || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}
