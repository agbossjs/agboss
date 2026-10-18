import { STEPS_PER_WORKING_NODE, StepsLimitExceededError } from "../../graph/limits.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind, type ErrorClass } from "../ast.js";
import type { ComponentName } from "../registry.js";
import { EdgeKind, type FlowEdge, type FlowGraph, type FlowNode } from "./flow-graph.js";
import type { AnalysisContext } from "./rules/context.js";

/**
 * `maxSteps` bounds at assembly (#261 AC17, two passes over the graph): for every node, the fewest
 * steps from a start up to it and including it, plus the fewest from it to a finish. Weights: an
 * agent or a router visit is 1; a start, an action and a finish are 0. A node with a handler of the
 * steps limit (`.onError(StepsLimitExceededError, …)`, or a parent class) counts as reaching a finish: the visit past the
 * limit fails before it runs, into the handler. Only a hand-set
 * `maxSteps` is checked: the default always fits.
 */

const weightOf = (node: FlowNode | undefined): number =>
  node?.kind === NodeKind.Agent || node?.kind === NodeKind.Router ? 1 : 0;

/** Whether `.onError(error, …)` catches the steps limit (`StepsLimitExceededError` or a parent class). */
const catchesStepsLimit = (error: ErrorClass | undefined): boolean =>
  error !== undefined &&
  (error === StepsLimitExceededError || StepsLimitExceededError.prototype instanceof error);

type Distances = ReadonlyMap<ComponentName, number>;

/** An edge with what taking it counts: the node it enters, and the branches a join waits for. */
interface WeightedEdge {
  readonly from: ComponentName;
  readonly to: ComponentName;
  readonly weight: number;
}

/** The steps of a join's branches that always run: `Always` + `FailFast` agents, no per-item run. */
function alwaysRunning(graph: FlowGraph, edge: FlowEdge): number {
  const launch = edge.kind === EdgeKind.Join ? edge.launch : undefined;
  if (launch === undefined || launch.items !== undefined) return 0;
  return launch.branches
    .filter((branch) => branch.alwaysRuns)
    .reduce((total, branch) => total + branch.copies * weightOf(graph.nodes.get(branch.node)), 0);
}

/** The edges that count (a launch edge does not: its branches count on the join), weighted. */
const weighted = (graph: FlowGraph, edges: readonly FlowEdge[]): readonly WeightedEdge[] =>
  edges
    .filter((edge) => edge.kind !== EdgeKind.Launch)
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      weight: weightOf(graph.nodes.get(edge.to)) + alwaysRunning(graph, edge),
    }));

/** Fewest steps over `edges` from the `seeds` (with their own weights), each edge's weight added. */
function shortest(
  seeds: ReadonlyMap<ComponentName, number>,
  edges: readonly WeightedEdge[],
): Distances {
  const distances = new Map(seeds);
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to, weight } of edges) {
      const via = (distances.get(from) ?? Infinity) + weight;
      if (via >= (distances.get(to) ?? Infinity)) continue;
      distances.set(to, via);
      changed = true;
    }
  }
  return distances;
}

const fromStart = (graph: FlowGraph, start: ComponentName): Distances =>
  shortest(new Map([[start, 0]]), weighted(graph, graph.edges));

/** Fewest steps from each node to a finish, the node included. */
function toFinish(graph: FlowGraph): Distances {
  const seeds = new Map<ComponentName, number>();
  for (const node of graph.nodes.values())
    if (node.kind === NodeKind.Finish) seeds.set(node.name, 0);
  for (const edge of graph.edges) {
    if (catchesStepsLimit(edge.error)) seeds.set(edge.from, 0);
  }
  const exits = graph.edges.filter(
    (edge) => edge.kind !== EdgeKind.Error && edge.kind !== EdgeKind.JoinError,
  );
  // reversed: the weight of an edge is what entering its `to` counts, so it moves to `from`
  const reversed = weighted(graph, exits).map((edge) => ({
    from: edge.to,
    to: edge.from,
    weight: edge.weight - weightOf(graph.nodes.get(edge.to)) + weightOf(graph.nodes.get(edge.from)),
  }));
  return shortest(seeds, reversed);
}

/** The fewest steps of an execution through each node, from the given starts. */
function throughCounts(
  graph: FlowGraph,
  exits: Distances,
  starts: readonly ComponentName[],
): Distances {
  const least = new Map<ComponentName, number>();
  for (const start of starts) {
    for (const [node, before] of fromStart(graph, start)) {
      const exit = exits.get(node);
      if (exit === undefined) continue;
      const through = before + exit - weightOf(graph.nodes.get(node));
      least.set(node, Math.min(least.get(node) ?? Infinity, through));
    }
  }
  return least;
}

function boundViolations(graph: FlowGraph, maxSteps: number): readonly RuleViolation[] {
  const exits = toFinish(graph);
  const limit = String(maxSteps);
  const tooLow = graph.starts.flatMap((start) => {
    const steps = exits.get(start);
    if (steps === undefined || steps <= maxSteps) return [];
    const message = `the shortest path from ${start} takes ${String(steps)} steps, but maxSteps is ${limit}`;
    return [violation("limits.max-steps-too-low", message, [start])];
  });
  const fitting = graph.starts.filter((start) => (exits.get(start) ?? Infinity) <= maxSteps);
  const branches = [...throughCounts(graph, exits, fitting)]
    .filter(([node, steps]) => steps > maxSteps && weightOf(graph.nodes.get(node)) > 0)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([node, steps]) => {
      const message = `every path through ${node} takes at least ${String(steps)} steps, but maxSteps is ${limit}`;
      return violation("limits.branch-exceeds-max-steps", message, [node]);
    });
  return [...tooLow, ...branches];
}

/**
 * The default `maxSteps` — (agents + routers) × 3 — must hold the worst case (#273 S68 f): a flow
 * whose longest path, with every launch at full width (`maxItems` runs of a per-item launch, every
 * copy), takes more steps fails, and the fix is an explicit `@Workflow({ maxSteps })` — never a
 * silently larger default. A cycle is bounded by `maxSteps` itself, so it is not checked here.
 */
function defaultViolations(graph: FlowGraph): readonly RuleViolation[] {
  const working = [...graph.nodes.values()].filter((node) => weightOf(node) > 0).length;
  const limit = working * STEPS_PER_WORKING_NODE;
  return graph.starts.flatMap((start) => {
    const most = mostStepsFrom(graph, start);
    if (most === undefined || most <= limit) return [];
    const message =
      `the worst case from ${start} takes ${String(most)} steps, but the default maxSteps ` +
      `(agents + routers) × ${String(STEPS_PER_WORKING_NODE)} is ${String(limit)} — set @Workflow({ maxSteps })`;
    return [violation("limits.max-steps-too-low", message, [start])];
  });
}

export function stepsRules(context: AnalysisContext): readonly RuleViolation[] {
  const { maxSteps, name } = context.workflow;
  if (maxSteps === undefined) return defaultViolations(context.graph);
  const counted = [...context.graph.nodes.values()].some((node) => weightOf(node) > 0);
  if (counted) return boundViolations(context.graph, maxSteps);
  const message =
    `${name} has maxSteps: ${String(maxSteps)}, but it has no agent or router — steps are ` +
    "always 0; remove maxSteps";
  return [violation("limits.max-steps-unused", message, [])];
}

/** The fewest and the most steps an execution can take; `most` is undefined when a cycle bounds it. */
export interface StepsRange {
  readonly least: number;
  readonly most?: number;
}

/**
 * The most steps a join's branches can take (#273): every copy, a per-item launch `maxItems` times;
 * undefined for a per-item launch without `maxItems` (`[launch.max-items-required]`).
 */
export function mostRunning(graph: FlowGraph, edge: FlowEdge): number | undefined {
  const launch = edge.kind === EdgeKind.Join ? edge.launch : undefined;
  if (launch === undefined) return 0;
  const width = launch.items === undefined ? 1 : launch.maxItems;
  if (width === undefined) return undefined;
  return launch.branches.reduce(
    (total, branch) => total + branch.copies * width * weightOf(graph.nodes.get(branch.node)),
    0,
  );
}

/** The longest weighted path from `node` to a finish; undefined on a cycle or an unbounded launch. */
function longest(
  graph: FlowGraph,
  node: ComponentName,
  onPath: ReadonlySet<ComponentName>,
  memo: Map<ComponentName, number | undefined>,
): number | undefined {
  if (onPath.has(node)) return undefined;
  if (memo.has(node)) return memo.get(node);
  const next = new Set([...onPath, node]);
  let most = 0;
  for (const edge of graph.edges) {
    if (edge.from !== node || edge.kind === EdgeKind.Launch) continue;
    const after = longest(graph, edge.to, next, memo);
    const branches = mostRunning(graph, edge);
    if (after === undefined || branches === undefined) return undefined;
    most = Math.max(most, after + branches);
  }
  const total = most + weightOf(graph.nodes.get(node));
  memo.set(node, total);
  return total;
}

/** The most steps of an execution from `start`: undefined when a cycle (or an unbounded launch) bounds it. */
export const mostStepsFrom = (graph: FlowGraph, start: ComponentName): number | undefined =>
  longest(graph, start, new Set(), new Map());

/** The steps range of a workflow (`agboss describe`, #261): shortest way out, longest without cycles. */
export function stepsRangeOf(graph: FlowGraph): StepsRange {
  const exits = toFinish(graph);
  const least = Math.min(...graph.starts.map((start) => exits.get(start) ?? Infinity));
  const memo = new Map<ComponentName, number | undefined>();
  const lengths = graph.starts.map((start) => longest(graph, start, new Set(), memo));
  const most = lengths.some((length) => length === undefined)
    ? undefined
    : Math.max(0, ...lengths.map((length) => length ?? 0));
  const leastSteps = Number.isFinite(least) ? least : 0;
  return most === undefined ? { least: leastSteps } : { least: leastSteps, most };
}
