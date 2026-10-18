import {
  EdgeKind,
  type FlowEdge,
  type FlowLaunch,
  type ValueWrite,
} from "../../analyse/flow-graph.js";

/**
 * A parallel launch as the runtime runs it (#273 S20): the launching node, its branch nodes, the
 * values the launching step writes before the branches start, the join's way on and its
 * `.onJoinError(…)` side paths, and the LangGraph node that joins it. A node launches from one
 * place, or from several `caseOf(…)` branches — then each variant has its own launch.
 */

/** One launch of the graph. */
export interface RuntimeLaunch {
  /** Its key in the graph: the launcher, plus the variant of a launch inside `caseOf(…)`. */
  readonly key: string;
  /** The LangGraph node that joins it: not a component, never in `result.path`. */
  readonly joinNodeId: string;
  readonly launch: FlowLaunch;
  /** The variant (DTO class name) whose `caseOf(…)` launches it; undefined outside a switch. */
  readonly variant?: string;
  /** What the launching step writes at the launch: its `.returns(…)` (a branch's item excluded). */
  readonly writes: readonly ValueWrite[];
  /** The edge the join takes when every branch finished (or dropped out). */
  readonly join: FlowEdge;
  /** `.onJoinError(E, …)`: the side paths a failed launch takes. */
  readonly joinErrors: readonly FlowEdge[];
}

/** The key of the launches of a node outside a switch. */
export const NO_VARIANT = "";

const variantOf = (edge: FlowEdge): string | undefined => {
  const write = edge.writes.find((candidate) => candidate.isCase);
  return write !== undefined && typeof write.shape === "function" ? write.shape.name : undefined;
};

/** The launching step's own values: a launch edge's writes without a per-item branch's item. */
const launcherWrites = (edge: FlowEdge, launch: FlowLaunch): readonly ValueWrite[] =>
  launch.items !== undefined && typeof launch.items.element === "function"
    ? edge.writes.slice(0, -1)
    : edge.writes;

function runtimeLaunchOf(launch: FlowLaunch, edges: readonly FlowEdge[]): RuntimeLaunch {
  const [first] = edges.filter((edge) => edge.kind === EdgeKind.Launch);
  const join = edges.find((edge) => edge.kind === EdgeKind.Join);
  if (first === undefined || join === undefined)
    throw new TypeError(
      `${launch.launcher}: a launch without branches or a join reached the runtime`,
    );
  const variant = variantOf(first);
  const key = variant === undefined ? launch.launcher : `${launch.launcher}.${variant}`;
  return {
    key,
    joinNodeId: `${key}.join`,
    launch,
    ...(variant === undefined ? {} : { variant }),
    writes: launcherWrites(first, launch),
    join,
    joinErrors: edges.filter((edge) => edge.kind === EdgeKind.JoinError),
  };
}

/** The launches among a node's outgoing edges, by the variant that launches them. */
export function launchesOf(edges: readonly FlowEdge[]): ReadonlyMap<string, RuntimeLaunch> {
  const byLaunch = new Map<FlowLaunch, FlowEdge[]>();
  for (const edge of edges) {
    if (edge.launch === undefined) continue;
    byLaunch.set(edge.launch, [...(byLaunch.get(edge.launch) ?? []), edge]);
  }
  const launches = [...byLaunch].map(([launch, own]) => runtimeLaunchOf(launch, own));
  return new Map(launches.map((launch) => [launch.variant ?? NO_VARIANT, launch] as const));
}
