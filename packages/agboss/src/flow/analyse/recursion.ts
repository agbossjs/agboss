import { NodeKind } from "../ast.js";
import { isCodeRouter } from "../decorators/router.js";
import type { ComponentName } from "../registry.js";
import { THIS_WORKFLOW_NAME } from "../this-workflow.js";
import {
  EdgeKind,
  outgoingEdges,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow-graph.js";

/**
 * Where a workflow recurses (#264): the branches of its graph — a `.switch(caseOf(…))` after a step,
 * a `.chooseOne(route(…))` after a router — and, of each, the options whose path launches
 * `ThisWorkflow` before any other branch decides. A path is followed through its next steps and its
 * launches and joins, never into `.onError` side paths, and it stops at the next branch: a choice
 * made further on is that branch's own. What the runtime does with them on the last level
 * (`depth === maxDepth`) depends on who decides: an agent's variants leave its response schema and a
 * model router's routes are hidden (the soft stop); a code router choosing one fails with
 * `RouterDecisionError`; any other launch beyond `maxDepth` fails with `DepthLimitExceededError`.
 */

/** Who decides a branch, so how its recursive options stop on the last level. */
export enum RecursionDecider {
  /** An agent's `oneOf` answer: the recursive variants leave its response schema. */
  Agent = "agent",
  /** A model router: the recursive routes are hidden from its model. */
  ModelRouter = "model-router",
  /** A code router: returning a recursive route fails with `RouterDecisionError`. */
  CodeRouter = "code-router",
  /** Code or data (an action's or a child's `oneOf`): a launch beyond `maxDepth` fails. */
  Data = "data",
}

/** One branch of the graph with at least one option that recurses. */
export interface RecursiveBranch {
  readonly node: ComponentName;
  readonly decider: RecursionDecider;
  /** Every option: a variant's DTO class name, or a route's target node. */
  readonly options: readonly string[];
  /** The options whose path launches `ThisWorkflow`. */
  readonly recursive: readonly string[];
}

/** How a workflow recurses: absent when its flow never reaches `ThisWorkflow`. */
export interface Recursion {
  readonly maxDepth?: number;
  readonly branches: readonly RecursiveBranch[];
}

/** The kinds of edge a recursive path is followed along. */
const FOLLOWED: ReadonlySet<EdgeKind> = new Set([
  EdgeKind.Next,
  EdgeKind.Launch,
  EdgeKind.Join,
  EdgeKind.Case,
  EdgeKind.Route,
]);

/** The variant a case edge (or a launch inside a case) writes, by its DTO class name. */
const variantOf = (edge: FlowEdge): string | undefined => {
  const write = edge.writes.find((candidate) => candidate.isCase);
  return write !== undefined && typeof write.shape === "function" ? write.shape.name : undefined;
};

/** The option an edge leaving a branch takes, if it is one: its variant, or its route's target. */
const optionOf = (edge: FlowEdge): string | undefined =>
  edge.kind === EdgeKind.Route ? edge.to : variantOf(edge);

/** Whether a node branches: some edge leaving it is a `caseOf(…)` or a `route(…)` option. */
const isBranch = (edges: readonly FlowEdge[]): boolean =>
  edges.some((edge) => FOLLOWED.has(edge.kind) && optionOf(edge) !== undefined);

/** Whether a path entering `start` launches `ThisWorkflow` before the next branch. */
function recurses(
  start: ComponentName,
  leaving: ReadonlyMap<ComponentName, readonly FlowEdge[]>,
): boolean {
  const seen = new Set<ComponentName>();
  const queue: ComponentName[] = [start];
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    if (node === THIS_WORKFLOW_NAME) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    const edges = leaving.get(node) ?? [];
    if (isBranch(edges)) continue;
    for (const edge of edges) if (FOLLOWED.has(edge.kind)) queue.push(edge.to);
  }
  return false;
}

function deciderOf(node: FlowNode): RecursionDecider {
  const { declaration } = node;
  if (declaration.kind === NodeKind.Agent) return RecursionDecider.Agent;
  if (declaration.kind !== NodeKind.Router) return RecursionDecider.Data;
  return isCodeRouter(declaration.options)
    ? RecursionDecider.CodeRouter
    : RecursionDecider.ModelRouter;
}

/** One branching node's options and those that recurse; undefined when none does. */
function branchOf(
  node: FlowNode,
  leaving: ReadonlyMap<ComponentName, readonly FlowEdge[]>,
): RecursiveBranch | undefined {
  const byOption = new Map<string, FlowEdge[]>();
  for (const edge of leaving.get(node.name) ?? []) {
    const option = FOLLOWED.has(edge.kind) ? optionOf(edge) : undefined;
    if (option !== undefined) byOption.set(option, [...(byOption.get(option) ?? []), edge]);
  }
  const recursive = [...byOption]
    .filter(([, edges]) => edges.some((edge) => recurses(edge.to, leaving)))
    .map(([option]) => option);
  if (recursive.length === 0) return undefined;
  return {
    node: node.name,
    decider: deciderOf(node),
    options: [...byOption.keys()].sort(),
    recursive: recursive.sort(),
  };
}

/** How the graph recurses; undefined when it has no `ThisWorkflow` node. */
export function recursionOf(graph: FlowGraph, maxDepth: number | undefined): Recursion | undefined {
  if (!graph.nodes.has(THIS_WORKFLOW_NAME)) return undefined;
  const leaving = outgoingEdges(graph);
  const branches = [...graph.nodes.values()].flatMap((node) => branchOf(node, leaving) ?? []);
  return maxDepth === undefined ? { branches } : { maxDepth, branches };
}

/** The options a branch keeps on the last level: all but its recursive ones. */
export const lastLevelOptionsOf = (branch: RecursiveBranch): readonly string[] =>
  branch.options.filter((option) => !branch.recursive.includes(option));

/** Whether a branch is a router's `.chooseOne(…)` (its options are routes), else a `.switch(…)`. */
export const isRouterBranch = (branch: RecursiveBranch): boolean =>
  branch.decider === RecursionDecider.ModelRouter || branch.decider === RecursionDecider.CodeRouter;
