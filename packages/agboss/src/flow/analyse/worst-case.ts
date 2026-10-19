import { STEPS_PER_WORKING_NODE } from "../../graph/limits.js";
import { NodeKind } from "../ast.js";
import type { ComponentName } from "../registry.js";
import type { Class } from "../../components/injection.js";
import { declarationOf } from "../decorators/declaration.js";
import {
  EdgeKind,
  reachableFrom,
  type FlowEdge,
  type FlowGraph,
  type FlowLaunch,
} from "./flow-graph.js";
import { walkFlow } from "./walk.js";
import { launchLabel } from "./join-groups.js";
import { mostStepsFrom } from "./steps.js";

/**
 * The worst case of one call of each start (#261 start log, #273, #263), from the decorators only:
 * the workflow executions in total and at the same time — the execution itself plus, for every
 * edge into a child workflow it can reach, the child's own worst case, `maxItems` times for a
 * per-item launch (at most `maxConcurrency` of them at once) — the nesting depth, the agent and
 * router steps of the execution itself (a child counts its own) — the longest path with every
 * launch at full width, capped by `maxSteps`, which stops the execution — and how each number is
 * made up. Each edge into a child is counted once: a loop through a child is bounded by `maxSteps`.
 */

export interface WorstCase {
  readonly start: ComponentName;
  readonly executions: number;
  readonly concurrentExecutions: number;
  /** Agent and router steps at most. */
  readonly steps: number;
  /** Nesting depth of child workflows below the execution: 0 without children. */
  readonly depth: number;
  /** What the numbers are made of: `maxItems 50 on screening-agent → …`, `maxSteps 12`. */
  readonly parts: readonly string[];
}

/** `maxSteps`, else its default: (agents + routers) × 3. */
export function maxStepsOf(graph: FlowGraph, maxSteps: number | undefined): number {
  if (maxSteps !== undefined) return maxSteps;
  const working = [...graph.nodes.values()].filter(
    (node) => node.kind === NodeKind.Agent || node.kind === NodeKind.Router,
  ).length;
  return working * STEPS_PER_WORKING_NODE;
}

/** The launches an execution from `start` can reach. */
function launchesFrom(graph: FlowGraph, start: ComponentName): readonly FlowLaunch[] {
  const reached = reachableFrom([start], graph.edges);
  const launches = new Set<FlowLaunch>();
  for (const edge of graph.edges)
    if (edge.launch !== undefined && reached.has(edge.from)) launches.add(edge.launch);
  return [...launches];
}

function launchParts(launch: FlowLaunch): readonly string[] {
  const label = launchLabel(launch);
  return [
    ...(launch.maxItems === undefined ? [] : [`maxItems ${String(launch.maxItems)} on ${label}`]),
    ...(launch.maxConcurrency === undefined
      ? []
      : [`maxConcurrency ${String(launch.maxConcurrency)} on ${label}`]),
  ];
}

/** The executions below one call: how many, how many at once, how deep, and what makes them. */
interface ChildrenCase {
  readonly executions: number;
  readonly concurrentExecutions: number;
  readonly depth: number;
  readonly parts: readonly string[];
}

/** Where an execution stands in its tree: the workflows above it, its own, its depth from 1. */
interface Place {
  readonly above: readonly Class[];
  readonly self?: Class;
  readonly depth: number;
}

/** The count limits of a workflow (`@Workflow({ maxSteps, maxDepth })`). */
export interface Limits {
  readonly maxSteps?: number;
  readonly maxDepth?: number;
}

const NO_CHILDREN: ChildrenCase = { executions: 0, concurrentExecutions: 0, depth: 0, parts: [] };

/** How many children an edge into a child starts, and how many of them at once. */
function widthOf(edge: FlowEdge): { readonly count: number; readonly atOnce: number } {
  const launch = edge.kind === EdgeKind.Launch ? edge.launch : undefined;
  if (launch?.items === undefined) return { count: 1, atOnce: 1 };
  const count = launch.maxItems ?? 1;
  return { count, atOnce: Math.min(launch.maxConcurrency ?? count, count) };
}

/** The worst case of one execution of a child workflow: its worst start's. */
function childCaseOf(workflow: Class, at: Place): WorstCase | undefined {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow || at.above.includes(workflow)) return undefined;
  const { graph } = walkFlow(declaration.options.flow, workflow);
  const below = { above: [...at.above, workflow], self: workflow, depth: at.depth + 1 };
  const cases = worstCasesBelow(graph, declaration.options, below);
  return cases.reduce<WorstCase | undefined>(
    (worst, next) => (worst === undefined || next.executions > worst.executions ? next : worst),
    undefined,
  );
}

/**
 * The worst case of `ThisWorkflow` (#264): the workflow again, one level deeper — none from its
 * last level (`maxDepth`), where a recursive launch is never offered or fails before it starts.
 */
function recursiveCaseOf(at: Place, maxDepth: number | undefined): WorstCase | undefined {
  const { self } = at;
  if (self === undefined || maxDepth === undefined || at.depth >= maxDepth) return undefined;
  return childCaseOf(self, { ...at, above: at.above.filter((above) => above !== self) });
}

/** Every child execution one call of `start` can launch (#263), itself included (#264). */
function childrenFrom(
  graph: FlowGraph,
  start: ComponentName,
  at: Place,
  limits: Limits,
): ChildrenCase {
  const reached = reachableFrom([start], graph.edges);
  return graph.edges.reduce<ChildrenCase>((total, edge) => {
    const node = graph.nodes.get(edge.to);
    if (!reached.has(edge.from) || node?.kind !== NodeKind.Workflow) return total;
    const child =
      node.recursionOf === undefined
        ? childCaseOf(node.component, at)
        : recursiveCaseOf(at, limits.maxDepth);
    if (child === undefined) return total;
    const { count, atOnce } = widthOf(edge);
    return {
      executions: total.executions + count * child.executions,
      concurrentExecutions: Math.max(
        total.concurrentExecutions,
        atOnce * child.concurrentExecutions,
      ),
      depth: Math.max(total.depth, 1 + child.depth),
      parts: [...total.parts, `${String(count)} × ${node.name}`],
    };
  }, NO_CHILDREN);
}

/** The worst case of one call of `start`. */
function worstCaseFrom(
  graph: FlowGraph,
  start: ComponentName,
  at: Place,
  limits: Limits,
): WorstCase {
  const maxSteps = maxStepsOf(graph, limits.maxSteps);
  const most = mostStepsFrom(graph, start);
  const isCapped = most === undefined || most > maxSteps;
  const children = childrenFrom(graph, start, at, limits);
  const parts = [
    ...launchesFrom(graph, start).flatMap(launchParts),
    ...children.parts,
    ...(isCapped ? [`maxSteps ${String(maxSteps)}`] : []),
  ];
  return {
    start,
    executions: 1 + children.executions,
    concurrentExecutions: 1 + children.concurrentExecutions,
    steps: isCapped ? maxSteps : most,
    depth: children.depth,
    parts,
  };
}

/** The worst cases of a workflow at a place in the tree. */
function worstCasesBelow(graph: FlowGraph, limits: Limits, at: Place): readonly WorstCase[] {
  return graph.starts.map((start) => worstCaseFrom(graph, start, at, limits));
}

/** The worst case of one call of each start of a workflow (`self`, at the root: depth 1). */
export function worstCasesOf(graph: FlowGraph, limits: Limits, self?: Class): readonly WorstCase[] {
  return worstCasesBelow(graph, limits, {
    above: [],
    ...(self === undefined ? {} : { self }),
    depth: 1,
  });
}

/** The start log's line (#261): `Worst case of one x-workflow-start call: 1 workflow execution, …`. */
export function worstCaseLine(worst: WorstCase): string {
  const executions =
    worst.executions === 1
      ? "1 workflow execution"
      : `${String(worst.executions)} workflow executions`;
  return (
    `Worst case of one ${worst.start} call: ${executions}, ` +
    `${String(worst.concurrentExecutions)} at the same time, ${String(worst.steps)} agent and router steps`
  );
}
