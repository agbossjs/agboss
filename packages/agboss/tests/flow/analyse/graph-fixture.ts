import { NodeKind } from "../../../src/flow/ast.js";
import {
  EdgeKind,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "../../../src/flow/analyse/flow-graph.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";

/** A node as the step rules read it: its name, its kind and the `maxVisits` its declaration carries. */
export const node = (name: string, kind: NodeKind, maxVisits?: unknown): FlowNode =>
  ({
    name,
    kind,
    declaration: { kind, options: maxVisits === undefined ? {} : { maxVisits } },
  }) as never;

/** A component name, as the graph keys it. */
export const named = (text: string): ComponentName => text as never;

/** One launch branch, as a join edge's launch lists it. */
export interface LaunchBranchFixture {
  readonly node: string;
  readonly copies: number;
  readonly isOptional: boolean;
  readonly alwaysRuns: boolean;
}

export const branch = (name: string, copies: number, alwaysRuns: boolean): LaunchBranchFixture => ({
  node: name,
  copies,
  isOptional: false,
  alwaysRuns,
});

/** An edge; `launch` is a join's (`items`, `maxItems`, `branches`). */
export const edge = (
  from: string,
  to: string,
  kind: EdgeKind = EdgeKind.Next,
  more: { readonly error?: unknown; readonly launch?: unknown } = {},
): FlowEdge => ({ from, to, kind, writes: [], ...more }) as never;

/** A join edge whose launch has these branches, per item (`items`, with `maxItems`) or not. */
export const join = (
  from: string,
  to: string,
  branches: readonly LaunchBranchFixture[],
  perItem?: { readonly maxItems?: number },
): FlowEdge =>
  edge(from, to, EdgeKind.Join, {
    launch: { branches, ...(perItem === undefined ? {} : { items: {}, ...perItem }) },
  });

/** The graph of the nodes `[name, kind]` and the edges, with its starts. */
export const graphOf = (
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  starts: readonly string[],
): FlowGraph => ({
  nodes: new Map(nodes.map((one) => [one.name, one])),
  edges,
  starts: starts as never,
});

/** The context the step rules read: the workflow's name and `maxSteps`, and the graph. */
export const contextOf = (graph: FlowGraph, maxSteps?: unknown): AnalysisContext =>
  ({
    workflow: { name: "flow-workflow", ...(maxSteps === undefined ? {} : { maxSteps }) },
    graph,
  }) as never;
