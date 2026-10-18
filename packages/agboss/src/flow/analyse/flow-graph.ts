import type { Class } from "../../components/injection.js";
import { WorkflowFinishTextDto } from "../../dto/standard/framework.js";
import { NodeKind, type ErrorClass, type LaunchTargetKind } from "../ast.js";
import type { ComponentDeclaration } from "../decorators/declaration.js";
import type { DtoClass } from "../../dto/types.js";
import type { ListWrapper, OutputShape, ReturnedShape, ValueShape } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import type { JoinGroup } from "./join-groups.js";
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
  /** `.toParallelAgents(X)`: to one branch of a launch, with the scope at the launch (#273). */
  Launch = "launch",
  /** `.join()….to…(Y)`: from the launching step past its branches, with their values (#273). */
  Join = "join",
  /** `.join().onJoinError(E, toAction(X)…)`: the launch failed; the launching step's values only. */
  JoinError = "join-error",
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

/** A write of `shape`, with its `{ about }` when it has one. */
export const valueWrite = (
  shape: ValueShape,
  about: readonly DtoClass[] | undefined,
  isCase: boolean,
): ValueWrite => (about === undefined ? { shape, isCase } : { shape, about, isCase });

/** One target of a launch (#273): its node, how many copies, and whether it may be missing. */
export interface LaunchBranch {
  readonly node: ComponentName;
  /** How many times the launch lists it (`toParallelAgents(CriticAgent, CriticAgent)`: 2). */
  readonly copies: number;
  /** Its router route is `SpawnPolicy.OnDemand` or `FailurePolicy.Skip`: the join may lack it. */
  readonly isOptional: boolean;
  /** Its router route is `SpawnPolicy.Always` + `FailurePolicy.FailFast` (or no router): it runs. */
  readonly alwaysRuns: boolean;
}

/** A launch as the graph keeps it: who launches what, and how wide (#273). */
export interface FlowLaunch {
  /** The launching step: an agent, an action, a start or a router. */
  readonly launcher: ComponentName;
  readonly targetKind: LaunchTargetKind;
  /** Distinct targets, in the order first listed. */
  readonly branches: readonly LaunchBranch[];
  /** The targets as listed, repeats included (the key of its `JoinOutputs` entry). */
  readonly listed: readonly ComponentName[];
  /** The list a per-item launch runs over: the `.returns(listOf(XDto))` right before it. */
  readonly items?: ListWrapper;
  readonly maxConcurrency?: number;
  readonly maxItems?: number;
  /** Launched right after a router: its routes' policies apply. */
  readonly isRouterLaunch: boolean;
}

/** What a join edge carries besides the launching step's own values (#273). */
export interface JoinEdge {
  readonly launch: FlowLaunch;
  /** `.join().returns(…)`: the branches' values, as written (a `oneOf(…)` is left to the rule). */
  readonly values: readonly ValueWrite[];
  /** The shapes written after `.join()`, for `[flow.returns-mismatch]` (a `oneOf(…)` included). */
  readonly written: readonly ReturnedShape[];
  /** What the branches give, by class: the values the join must name. */
  readonly groups: readonly JoinGroup[];
}

export interface FlowEdge {
  readonly from: ComponentName;
  readonly to: ComponentName;
  readonly kind: EdgeKind;
  /** The values of the step `from` (a launch edge adds a per-item branch's item last). */
  readonly writes: readonly ValueWrite[];
  /** The class an `EdgeKind.Error` / `EdgeKind.JoinError` edge catches. */
  readonly error?: ErrorClass;
  /** `EdgeKind.Launch` and `EdgeKind.Join` / `EdgeKind.JoinError`: the launch (#273). */
  readonly launch?: FlowLaunch;
  /** `EdgeKind.Join`: what the branches give. */
  readonly join?: JoinEdge;
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
  const joined = (edge.join?.written ?? []).map(shapeLabel).join(",");
  return [edge.from, edge.to, edge.kind, edge.error?.name ?? "", writes.join(","), joined].join(
    "|",
  );
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
