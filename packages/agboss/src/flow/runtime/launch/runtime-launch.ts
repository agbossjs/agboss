import type { Class } from "../../../components/injection.js";
import type { ArbiterClass, Quorum } from "../../ast.js";
import { componentModelOf, type ModelResolver } from "../../../models/model-resolver.js";
import { arbiterOf, hasArbiterModel } from "../../decorators/arbiter.js";
import {
  EdgeKind,
  type FlowEdge,
  type FlowLaunch,
  type ValueWrite,
} from "../../analyse/flow-graph.js";

/**
 * A parallel launch as the runtime runs it (#273 S20): the launching node, its branch nodes, the
 * values the launching step writes before the branches start, the join's way on and its
 * `.onError(…)` side paths, and the LangGraph node that joins it. A node launches from one
 * place, or from several a `.toOneOf([…])` branch branches — then each variant has its own launch. A quorum join
 * (#279) has its quorum; `.joinQuorumGroups(…)` one way on per group.
 */

/** One `.onGroup(…)` of `.joinQuorumGroups(…)`: its places and the edge its own path starts with. */
export interface RuntimeGroup {
  /** Its targets by node name as listed (repeats included). */
  readonly targets: readonly string[];
  readonly priority?: number;
  readonly edge: FlowEdge;
}

/** One launch of the graph. */
export interface RuntimeLaunch {
  /** Its key in the graph: the launcher, plus the variant of a launch inside a `.toOneOf([…])` branch. */
  readonly key: string;
  /** The LangGraph node that joins it: not a component, never in `result.path`. */
  readonly joinNodeId: string;
  readonly launch: FlowLaunch;
  /** The variant (DTO class name) whose a `.toOneOf([…])` branch launches it; undefined outside a switch. */
  readonly variant?: string;
  /** What the launching step writes at the launch: what its declaration gives (a branch's item excluded). */
  readonly writes: readonly ValueWrite[];
  /** The edge the join takes when every branch finished (or dropped out); a group's for groups. */
  readonly join: FlowEdge;
  /** `.joinQuorum(…)` / `.joinQuorumGroups(…)` (#279); absent for `.join()`. */
  readonly quorum?: Quorum;
  /** `.joinQuorumGroups(…)`: the groups in listed order, each with its own way on. */
  readonly groups: readonly RuntimeGroup[];
  /** `.onError(E, …)`: the side paths a failed launch takes. */
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
    const { targets, priority } = group;
    return [{ targets, ...(priority === undefined ? {} : { priority }), edge }];
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
  const arbiters = launches.flatMap((launch) => launch.launch.arbitratedBy ?? []);
  return [...new Set(arbiters)];
}

/** Every `@WorkingCalendar` class of the graph's quorum deadlines (#1306), once each: the container creates them. */
export function quorumCalendarClassesOf(launches: readonly RuntimeLaunch[]): readonly Class[] {
  return [...new Set(launches.flatMap((launch) => launch.quorum?.calendar ?? []))];
}

/** A model arbiter by its `name` and `model` (#279): a model use of the workflow. */
export interface ModelArbiterUse {
  readonly name: string;
  readonly model: string;
  /** The `name` of the `@ModelProvider` the cascade resolved it to (#1313). */
  readonly modelProvider?: string;
  /** The provider has no `cost`: its calls are `CostSource.Unpriced` (#1313). */
  readonly unpriced?: true;
  /** Its `prompt` as assembly read it (#1347); `""` for a use made without one. */
  readonly prompt: string;
}

/**
 * The model arbiters of the graph's launches; with a `resolver`, each model through its cascade
 * (its own provider, its workflow's, its application's, #1313); `prompts` are the texts assembly
 * read, by arbiter name.
 */
export const modelArbitersOf = (
  launches: readonly RuntimeLaunch[],
  resolver?: ModelResolver,
  prompts: ReadonlyMap<string, string> = new Map(),
): readonly ModelArbiterUse[] =>
  arbiterClassesOf(launches).flatMap((arbiter): ModelArbiterUse[] => {
    const options = arbiterOf(arbiter)?.options;
    if (options === undefined || !hasArbiterModel(options)) return [];
    const key = `arbiters.${options.name}`;
    const own = { model: options.model, provider: options.modelProvider, isRequired: true };
    return [
      {
        name: options.name,
        ...componentModelOf(resolver, key, own),
        prompt: prompts.get(options.name) ?? "",
      },
    ];
  });
