import type { FlowNodeKind, FlowPath } from "../ast.js";
import { ComponentKind } from "./records.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import { ExecutionError } from "../../core/error-families/run-errors.js";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import type { ErrorRecord } from "../../core/error-record.js";
import { bestHandlerOf } from "./error-handler-rank.js";
import { isHandOverRecord } from "../../core/error-families/hand-over.js";
import type { FlowAnalysis } from "../analyse/analyse.js";
import type { ResolvedField } from "../analyse/fields.js";
import { EdgeKind, type FlowEdge, type FlowNode } from "../analyse/flow-graph.js";
import { isFieldMap, type ComponentDeclaration } from "../decorators/declaration.js";
import { isCodeRouter } from "../decorators/router.js";
import {
  Wrapper,
  type HistoryWrapper,
  type OutputShape,
  type ValueShape,
} from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import {
  arbiterClassesOf,
  launchesOf,
  quorumCalendarClassesOf,
  type RuntimeLaunch,
} from "./launch/runtime-launch.js";
import { arbiterOf, isCodeArbiter } from "../decorators/arbiter.js";
import { runtimeProvenanceOf, type RuntimeProvenance } from "./provenance.js";

import { placementOfWorkflow, type Placements } from "../analyse/child-placements.js";
import { isQueued, type ChildPlacement } from "../child-placement.js";
/**
 * A v2 workflow as its runtime reads it (#272 → Runtime): every node with its fields and its
 * outgoing edges grouped by how they are taken — the one next step, the `switch` cases by the
 * variant's class name, the router's routes by target, the `.onError` handlers, its parallel
 * launches (#273).
 */

/** A node's ways out. */
export interface NodeExits {
  readonly next?: FlowEdge;
  /** a `.toOneOf([…])` branch by the DTO class name. */
  readonly cases: ReadonlyMap<string, FlowEdge>;
  /** `.onRoute(toAgent(X)…)` by the target's node id. */
  readonly routes: ReadonlyMap<string, FlowEdge>;
  readonly errors: readonly FlowEdge[];
  /** Its parallel launches (#273), by the variant whose a `.toOneOf([…])` branch launches (`""` outside one). */
  readonly launches: ReadonlyMap<string, RuntimeLaunch>;
}

export interface RuntimeNode {
  /** The LangGraph node id: the component's `name`. */
  readonly id: ComponentName;
  readonly kind: FlowNodeKind;
  readonly component: Class;
  readonly declaration: ComponentDeclaration;
  /** What it reads from the path scope (#270), resolved by the analyser. */
  readonly fields: readonly ResolvedField[];
  readonly exits: NodeExits;
  readonly maxVisits?: number;
  /**
   * A child workflow's node launched with `placement: ChildPlacement.AnyWorker` (#333 PR 2): its
   * children are queued for any instance; absent — they run inside the parent's step.
   */
  readonly placement?: ChildPlacement;
}

export interface RuntimeGraph {
  readonly workflow: string;
  /** The `@Workflow` class (`executionContext.workflow.type`). */
  readonly type: Class;
  readonly nodes: ReadonlyMap<string, RuntimeNode>;
  readonly starts: readonly string[];
  /** The paths as written (`@Workflow({ flow })`): `describe`, Studio, the config fingerprint. */
  readonly flow: readonly FlowPath[];
  /** Every DTO class of the graph by class name (S5: a stored `variant` names its class). */
  readonly dtos: ReadonlyMap<string, DtoClass>;
  /** Every parallel launch of the graph (#273): each has a join node of its own. */
  readonly launches: readonly RuntimeLaunch[];
  /** The nodes launched as branches: they run only inside a launch, their join continues them. */
  readonly branchNodes: ReadonlySet<string>;
  /** What each producer's values are built from (#271): agents without `input`. */
  readonly provenance: RuntimeProvenance;
  readonly analysis: FlowAnalysis;
}

function exitsOf(edges: readonly FlowEdge[]): NodeExits {
  const cases = new Map<string, FlowEdge>();
  const routes = new Map<string, FlowEdge>();
  for (const edge of edges) {
    const key = edge.caseKey;
    if (edge.kind === EdgeKind.Case && key !== undefined) cases.set(key, edge);
    if (edge.kind === EdgeKind.Route) routes.set(edge.to, edge);
  }
  const next = edges.find((edge) => edge.kind === EdgeKind.Next);
  const errors = edges.filter((edge) => edge.kind === EdgeKind.Error);
  const launches = launchesOf(edges);
  return { ...(next === undefined ? {} : { next }), cases, routes, errors, launches };
}

/** A router decided by its class's `route(input)` (`DecidedBy.Code`, #280). */
export const isCodeRouterNode = (node: Pick<RuntimeNode, "declaration">): boolean =>
  node.declaration.kind === ComponentKind.Router && isCodeRouter(node.declaration.options);

/** A node whose class the container creates — its code runs: an action, a code router. */
export const isCodeNode = (node: Pick<RuntimeNode, "declaration">): boolean => {
  const { declaration } = node;
  return declaration.kind === ComponentKind.Action || isCodeRouterNode(node);
};

/** The undo actions the graph's actions declare (#340): run by the runtime even off every path. */
const compensatorsOf = (nodes: Iterable<RuntimeNode>): readonly Class[] =>
  [...nodes].flatMap(({ declaration }) =>
    declaration.kind === ComponentKind.Action && declaration.options.compensateWith !== undefined
      ? [declaration.options.compensateWith]
      : [],
  );

/**
 * The classes the container creates for a graph's code: actions, finishes with a handler, code
 * routers, code arbiters (#279), the actions' undo actions (#340) and the calendars of working-time
 * quorum deadlines (#1306).
 */
export const codeClassesOf = (
  graph: Pick<RuntimeGraph, "nodes" | "launches">,
): readonly Class[] => [
  ...[...graph.nodes.values()].flatMap((node) => (isCodeNode(node) ? [node.component] : [])),
  ...compensatorsOf(graph.nodes.values()),
  ...arbiterClassesOf(graph.launches).filter((arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    return options !== undefined && isCodeArbiter(options);
  }),
  ...quorumCalendarClassesOf(graph.launches),
];

const maxVisitsOf = (declaration: ComponentDeclaration): number | undefined =>
  declaration.kind === ComponentKind.Agent
    ? declaration.options.executionLimits?.maxVisits
    : declaration.kind === ComponentKind.Router || declaration.kind === ComponentKind.ExternalTask
      ? declaration.options.maxVisits
      : undefined;

/** Where a child workflow node runs when it is not in this process (#1286); `undefined` for the current one. */
const placementOf = (
  node: FlowNode,
  applicationPlacement: ChildPlacement | undefined,
  overrides: Placements | undefined,
): ChildPlacement | undefined => {
  if (node.kind !== ComponentKind.Workflow) return undefined;
  const placement = placementOfWorkflow(node.component, applicationPlacement, overrides);
  return isQueued(placement) ? placement : undefined;
};

/** The runtime's view of an analysed workflow. */
export function runtimeGraphOf(
  analysis: FlowAnalysis,
  flow: readonly FlowPath[],
  type: Class,
  where: { readonly default?: ChildPlacement | undefined; readonly overrides?: Placements } = {},
): RuntimeGraph {
  const nodes = new Map<string, RuntimeNode>();
  for (const node of analysis.graph.nodes.values()) {
    const maxVisits = maxVisitsOf(node.declaration);
    const placement = placementOf(node, where.default, where.overrides);
    const edges = analysis.graph.edges.filter((edge) => edge.from === node.name);
    nodes.set(node.name, {
      id: node.name,
      kind: node.kind,
      component: node.component,
      declaration: node.declaration,
      fields: analysis.fields.get(node.name) ?? [],
      exits: exitsOf(edges),
      ...(maxVisits === undefined ? {} : { maxVisits }),
      ...(placement === undefined ? {} : { placement }),
    });
  }
  return {
    workflow: analysis.workflow,
    type,
    nodes,
    starts: analysis.graph.starts,
    launches: [...nodes.values()].flatMap((node) => [...node.exits.launches.values()]),
    branchNodes: new Set(
      analysis.graph.edges.flatMap((edge) => (edge.kind === EdgeKind.Launch ? [edge.to] : [])),
    ),
    flow,
    dtos: dtoIndexOf(analysis),
    provenance: runtimeProvenanceOf(analysis.dataflow.provenance),
    analysis,
  };
}

/** The DTO classes a shape names. */
function dtosOf(shape: ValueShape | OutputShape | HistoryWrapper): readonly DtoClass[] {
  if (typeof shape === "function") return [shape];
  switch (shape.kind) {
    case Wrapper.List:
      return dtosOf(shape.element);
    case Wrapper.Optional:
      return dtosOf(shape.inner);
    case Wrapper.OneOf:
      return shape.variants;
    case Wrapper.History:
      return [shape.dto];
  }
}

/** The shapes a declaration names: its input fields and its output. */
function declaredShapes(
  declaration: ComponentDeclaration,
): readonly (ValueShape | OutputShape | HistoryWrapper)[] {
  const { options } = declaration;
  const input = "input" in options ? options.input : undefined;
  const output = "output" in options ? options.output : undefined;
  const inputs = input === undefined ? [] : isFieldMap(input) ? Object.values(input) : [input];
  return [...inputs, ...(output === undefined ? [] : [output])];
}

function dtoIndexOf(analysis: FlowAnalysis): ReadonlyMap<string, DtoClass> {
  const shapes = [
    ...[...analysis.graph.nodes.values()].flatMap((node) => declaredShapes(node.declaration)),
    ...analysis.graph.edges.flatMap((edge) => edge.writes.map((write) => write.shape)),
  ];
  return new Map(shapes.flatMap(dtosOf).map((dto) => [dto.name, dto] as const));
}

/** The code of `StepError.Action`: the wrapper the action runner puts around what an action's code threw. */
const ACTION_WRAPPER_CODE = "step.action";

/** The code every framework error has: a handler on it says nothing about the original's own class. */
const FRAMEWORK_CODE = "agboss";

/** A record of a cancel (`execution.cancelled`, or a fenced write after it): no `.onError` takes it (#1413). */
const isCancelRecord = (record: ErrorRecord): boolean =>
  record.lineage.some(
    (code) => code === ExecutionCancelledError.code || code === ExecutionError.CancelFenced.code,
  );

/**
 * The `.onError` handler of a failure: the one whose class matches most specifically — nearest in
 * the error's class line, then nearest in its cause chain; `.onError(Error, …)` only when nothing
 * else matches. An action's code that threw an error of its own is routed as that ORIGINAL error
 * (#1325): the runner's `StepError.Action` around it does not shadow a handler on the original's
 * class (a project's own error class), and takes it only when none matches. None → the failure is
 * not handled; a failed automatic undo never is (#340 Q4).
 */
export function errorHandlerOf(
  exits: Pick<NodeExits, "errors">,
  record: ErrorRecord,
): FlowEdge | undefined {
  if (
    record.code === ExecutionError.CompensationFailed.code ||
    isHandOverRecord(record) ||
    isCancelRecord(record)
  )
    return undefined;
  const original = record.lineage[0] === ACTION_WRAPPER_CODE ? record.cause : undefined;
  const ofOriginal =
    original === undefined
      ? undefined
      : bestHandlerOf(exits, original, (code) => code === FRAMEWORK_CODE);
  return ofOriginal ?? bestHandlerOf(exits, record);
}
