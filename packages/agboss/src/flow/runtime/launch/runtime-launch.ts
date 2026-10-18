import type { ArbiterClass, Quorum } from "../../ast.js";
import { arbiterOf, isCodeArbiter } from "../../decorators/arbiter.js";
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
 * place, or from several `caseOf(…)` branches — then each variant has its own launch. A quorum join
 * (#279) has its quorum; `.joinQuorumGroups(…)` one way on per group.
 */

/** One `group(…)` of `.joinQuorumGroups(…)`: its places and the edge its own path starts with. */
export interface RuntimeGroup {
  /** Its agents by node name as listed (repeats included). */
  readonly agents: readonly string[];
  readonly priority?: number;
  readonly edge: FlowEdge;
}

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
  /** The edge the join takes when every branch finished (or dropped out); a group's for groups. */
  readonly join: FlowEdge;
  /** `.joinQuorum(…)` / `.joinQuorumGroups(…)` (#279); absent for `.join()`. */
  readonly quorum?: Quorum;
  /** `.joinQuorumGroups(…)`: the groups in listed order, each with its own way on. */
  readonly groups: readonly RuntimeGroup[];
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

const groupsOf = (joins: readonly FlowEdge[]): readonly RuntimeGroup[] =>
  joins.flatMap((edge) => {
    const group = edge.join?.group;
    if (group === undefined) return [];
    const { agents, priority } = group;
    return [{ agents, ...(priority === undefined ? {} : { priority }), edge }];
  });

function runtimeLaunchOf(launch: FlowLaunch, edges: readonly FlowEdge[]): RuntimeLaunch {
  const [first] = edges.filter((edge) => edge.kind === EdgeKind.Launch);
  const joins = edges.filter((edge) => edge.kind === EdgeKind.Join);
  const [join] = joins;
  if (first === undefined || join === undefined)
    throw new TypeError(
      `${launch.launcher}: a launch without branches or a join reached the runtime`,
    );
  const variant = variantOf(first);
  const quorum = join.join?.quorum;
  const key = variant === undefined ? launch.launcher : `${launch.launcher}.${variant}`;
  return {
    key,
    joinNodeId: `${key}.join`,
    launch,
    ...(variant === undefined ? {} : { variant }),
    writes: launcherWrites(first, launch),
    join,
    ...(quorum === undefined ? {} : { quorum }),
    groups: groupsOf(joins),
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

/** Every `@Arbiter` class of the graph's launches (#279), once each, in the order first attached. */
export function arbiterClassesOf(launches: readonly RuntimeLaunch[]): readonly ArbiterClass[] {
  const chains = launches.flatMap((launch) => launch.launch.acceptedBy ?? []);
  return [...new Set(chains.flatMap((step) => step.arbiters))];
}

/** A model arbiter by its `name` and `model` (#279): a model use of the workflow. */
export interface ModelArbiterUse {
  readonly name: string;
  readonly model: string;
}

/** The model arbiters of the graph's launches. */
export const modelArbitersOf = (launches: readonly RuntimeLaunch[]): readonly ModelArbiterUse[] =>
  arbiterClassesOf(launches).flatMap((arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    return options === undefined || isCodeArbiter(options)
      ? []
      : [{ name: options.name, model: options.model }];
  });
