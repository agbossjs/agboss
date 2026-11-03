import { StepsLimitExceededError } from "../../graph/limits.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import type { ComponentName } from "../registry.js";
import { EdgeKind, type FlowEdge, type FlowGraph, type FlowNode } from "./flow-graph.js";
import type { AnalysisContext } from "./rules/context.js";
import { mostRunning } from "./steps.js";
import { isCycle, stronglyConnected } from "./strongly-connected.js";

/**
 * The worst case of a hand-set `maxSteps` (#643): a flow whose every cycle is bounded by `maxVisits`
 * has a finite worst case, and a `maxSteps` below it turns the designed end of a loop — its
 * `.onError(VisitsLimitExceededError, …)` side path — into `StepsLimitExceededError`. The bound is
 * the longest path over the flow's strongly connected components, each counted at the most its
 * visits allow: its bounded nodes `maxVisits` times each, and between two of their visits (every
 * cycle passes one) at most the longest path through its other nodes. A component with a launch
 * inside, or a cycle no `maxVisits` stops, has no bound: `maxSteps` is its only one, as before.
 * `[limits.max-steps-below-worst-case]` is a warning (an error under `--strict`); a flow that takes
 * the steps limit itself (`.onError(StepsLimitExceededError, …)`) is not checked.
 */

const weightOf = (node: FlowNode | undefined): number =>
  node?.kind === NodeKind.Agent || node?.kind === NodeKind.Router ? 1 : 0;

/** A node's `maxVisits`; `undefined` for a node without one. */
function maxVisitsOf(node: FlowNode | undefined): number | undefined {
  const declaration = node?.declaration;
  if (
    declaration?.kind !== NodeKind.Agent &&
    declaration?.kind !== NodeKind.Router &&
    declaration?.kind !== NodeKind.Question
  )
    return undefined;
  return declaration.options.maxVisits;
}

/** The edges a path of steps follows: a launch's own edges count on its join. */
const stepEdgesOf = (graph: FlowGraph): readonly FlowEdge[] =>
  graph.edges.filter((edge) => edge.kind !== EdgeKind.Launch);

/** One strongly connected component and the most steps one execution takes inside it. */
interface Component {
  readonly nodes: readonly ComponentName[];
  /** `undefined` when nothing but `maxSteps` bounds it. */
  readonly most: number | undefined;
  /** Its bounded nodes with their `maxVisits`, when it is a cycle: what the warning names. */
  readonly loop: readonly string[];
}

/** The longest path through `nodes` over `edges` (a graph without cycles), each node weighted. */
function longestAcyclic(
  graph: FlowGraph,
  nodes: ReadonlySet<ComponentName>,
  edges: readonly FlowEdge[],
): number {
  const memo = new Map<ComponentName, number>();
  const from = (node: ComponentName): number => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    const next = edges.filter((edge) => edge.from === node && nodes.has(edge.to));
    const most = weightOf(graph.nodes.get(node)) + Math.max(0, ...next.map((e) => from(e.to)));
    memo.set(node, most);
    return most;
  };
  return Math.max(0, ...[...nodes].map(from));
}

/** The most steps inside one component: its visits bounded by `maxVisits`, its other nodes between. */
function componentOf(
  graph: FlowGraph,
  nodes: readonly ComponentName[],
  edges: readonly FlowEdge[],
): Component {
  const members = new Set(nodes);
  const inner = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
  const successors = (node: ComponentName): readonly ComponentName[] =>
    inner.filter((edge) => edge.from === node).map((edge) => edge.to);
  const [only] = nodes;
  if (!isCycle(nodes, successors))
    return {
      nodes,
      most: weightOf(only === undefined ? undefined : graph.nodes.get(only)),
      loop: [],
    };
  const bounded = nodes.flatMap((name) => {
    const maxVisits = maxVisitsOf(graph.nodes.get(name));
    return maxVisits === undefined ? [] : [{ name, maxVisits }];
  });
  const loop = bounded.map(({ name, maxVisits }) => `${name} (maxVisits ${String(maxVisits)})`);
  if (inner.some((edge) => mostRunning(graph, edge) !== 0)) return { nodes, most: undefined, loop };
  const free = new Set(nodes.filter((name) => maxVisitsOf(graph.nodes.get(name)) === undefined));
  const freeEdges = inner.filter((edge) => free.has(edge.from) && free.has(edge.to));
  // a cycle no maxVisits stops: `[graph.cycle-without-max-visits]` reports it
  if (
    stronglyConnected([...free], (n) =>
      freeEdges.filter((e) => e.from === n).map((e) => e.to),
    ).some((part) => isCycle(part, (n) => freeEdges.filter((e) => e.from === n).map((e) => e.to)))
  )
    return { nodes, most: undefined, loop };
  const visits = bounded.reduce((total, { maxVisits }) => total + maxVisits, 0);
  const own = bounded.reduce(
    (total, { name, maxVisits }) => total + maxVisits * weightOf(graph.nodes.get(name)),
    0,
  );
  return { nodes, most: own + (visits + 1) * longestAcyclic(graph, free, freeEdges), loop };
}

/** The most steps from `start`, every cycle bounded by `maxVisits`, and the loops it passes. */
export interface BoundedSteps {
  readonly most: number;
  readonly loops: readonly string[];
}

/** The components of a flow, and the one each node belongs to. */
interface Components {
  readonly graph: FlowGraph;
  readonly edges: readonly FlowEdge[];
  readonly owner: ReadonlyMap<ComponentName, Component>;
}

/** The longest way on from `part` to an end of the flow; `undefined` when one way is unbounded. */
function longestOnward(
  { graph, edges, owner }: Components,
  part: Component,
  from: (next: Component) => BoundedSteps | undefined,
): BoundedSteps | undefined {
  let best: BoundedSteps = { most: 0, loops: [] };
  for (const edge of edges) {
    const target = owner.get(edge.to);
    if (!part.nodes.includes(edge.from) || target === undefined || target === part) continue;
    const after = from(target);
    const running = mostRunning(graph, edge);
    if (after === undefined || running === undefined) return undefined;
    if (after.most + running > best.most) best = { ...after, most: after.most + running };
  }
  return best;
}

/** The bounded worst case from `start`; `undefined` when a cycle or a launch leaves it unbounded. */
export function boundedStepsFrom(graph: FlowGraph, start: ComponentName): BoundedSteps | undefined {
  const edges = stepEdgesOf(graph);
  const successors = (node: ComponentName): readonly ComponentName[] =>
    edges.filter((edge) => edge.from === node).map((edge) => edge.to);
  const parts = stronglyConnected([...graph.nodes.keys()], successors).map((nodes) =>
    componentOf(graph, nodes, edges),
  );
  const owner = new Map(parts.flatMap((part) => part.nodes.map((n) => [n, part] as const)));
  const components: Components = { graph, edges, owner };
  // the components form a graph without cycles: each is reached once per way, memoized
  const memo = new Map<Component, BoundedSteps | undefined>();
  const from = (part: Component): BoundedSteps | undefined => {
    if (memo.has(part)) return memo.get(part);
    const onward = longestOnward(components, part, from);
    const found =
      part.most === undefined || onward === undefined
        ? undefined
        : { most: part.most + onward.most, loops: [...part.loop, ...onward.loops] };
    memo.set(part, found);
    return found;
  };
  const first = owner.get(start);
  return first === undefined ? undefined : from(first);
}

/** Whether a side path of the flow takes the steps limit: then a smaller `maxSteps` is meant. */
const takesStepsLimit = (graph: FlowGraph): boolean =>
  graph.edges.some(
    ({ error }) =>
      error !== undefined &&
      (error === StepsLimitExceededError || StepsLimitExceededError.prototype instanceof error),
  );

/** `[limits.max-steps-below-worst-case]` for each start whose bounded worst case `maxSteps` cuts. */
export function worstCaseStepsWarnings(context: AnalysisContext): readonly RuleViolation[] {
  const { maxSteps } = context.workflow;
  const { graph } = context;
  if (maxSteps === undefined || takesStepsLimit(graph)) return [];
  return graph.starts.flatMap((start) => {
    const worst = boundedStepsFrom(graph, start);
    if (worst === undefined || worst.most <= maxSteps) return [];
    const through = worst.loops.length === 0 ? "" : ` — through ${worst.loops.join(", ")}`;
    const message =
      `the worst case from ${start} takes ${String(worst.most)} steps${through}, but maxSteps is ` +
      `${String(maxSteps)}: a run that long fails with StepsLimitExceededError before its ` +
      `maxVisits ends it — set maxSteps: ${String(worst.most)}`;
    return [violation("limits.max-steps-below-worst-case", message, [start])];
  });
}
