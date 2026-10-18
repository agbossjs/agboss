import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../ast.js";
import type { ListWrapper } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import { childWorkflowOf, type ChildStart, type ChildWorkflow } from "./child-workflow.js";
import { statesOf, type Dataflow, type ScopeState } from "./dataflow.js";
import type { ResolvedField } from "./fields.js";
import { EdgeKind, type FlowEdge, type FlowGraph } from "./flow-graph.js";
import { shapeLabel } from "./labels.js";
import { stepOf } from "./launches.js";
import {
  slotOf,
  slotOfValue,
  SlotStatus,
  writtenValue,
  type AbstractScope,
  type SlotKey,
} from "./scope.js";

/**
 * Where a parent enters its child workflows (#263): every edge into a child picks the child's start
 * on its own, so two paths into `workflow(W)` may enter through two starts. A child with one start
 * is entered through it; otherwise by the value the edge brings — the item of a per-item launch
 * (`.toParallelWorkflows(W, …)` after `.returns(listOf(ItemDto))`), else the chain's current value
 * (the `.returns` or `caseOf` right before `.toWorkflow(W)`) — the start with a required field of
 * that type; of several, the one whose other required fields are all on the parent's path. The
 * child's scope starts with that start's input only: nothing else of the parent's scope enters it.
 */

/** One edge into a child workflow and the starts its value fits. */
export interface ChildEntry {
  readonly edge: FlowEdge;
  readonly child: ChildWorkflow;
  /** The value the start is chosen by; none when the edge brings no single value. */
  readonly value?: DtoClass | ListWrapper;
  readonly isPerItem: boolean;
  /** The starts with a required field of the value's type — the only start of a one-start child. */
  readonly candidates: readonly ChildStart[];
}

/** How an edge's start was chosen. */
export enum StartChoice {
  Chosen = "chosen",
  NoMatch = "no-match",
  Ambiguous = "ambiguous",
}

/** An edge's start, with the scopes the edge brings into the child (its start input's sources). */
export interface ChildChoice {
  readonly entry: ChildEntry;
  readonly choice: StartChoice;
  /** `Chosen`: the start; `Ambiguous`: the starts left to choose between. */
  readonly starts: readonly ChildStart[];
  readonly arriving: readonly ArrivingScope[];
}

/** A scope the edge leads into the child with, and the parent's state it was reached from. */
export interface ArrivingScope {
  readonly from: ScopeState;
  readonly scope: AbstractScope;
}

/** The value an edge's start is chosen by: a per-item launch's item, else its last value. */
function valueOf(edge: FlowEdge): ChildEntry["value"] {
  if (edge.kind === EdgeKind.Launch) {
    const element = edge.launch?.items?.element;
    return typeof element === "function" ? element : undefined;
  }
  const writes = edge.kind === EdgeKind.Join ? (edge.join?.values ?? []) : edge.writes;
  const last = writes[writes.length - 1];
  return last === undefined ? undefined : writtenValue(last.shape).value;
}

/** The starts with a required field of the value's type. */
function candidatesOf(child: ChildWorkflow, value: ChildEntry["value"]): readonly ChildStart[] {
  const [only, second] = child.starts;
  if (only !== undefined && second === undefined) return [only];
  if (value === undefined) return [];
  const slot = slotOfValue(value);
  return child.starts.filter((start) =>
    start.fields.some((field) => field.isRequired && field.slot === slot),
  );
}

/** Every edge into a child workflow of the graph, in the graph's canonical edge order. */
export function childEntriesOf(graph: FlowGraph): readonly ChildEntry[] {
  return graph.edges.flatMap((edge): readonly ChildEntry[] => {
    const node = graph.nodes.get(edge.to);
    if (node?.kind !== NodeKind.Workflow) return [];
    const child = childWorkflowOf(node.component);
    if (child === undefined) return [];
    const value = valueOf(edge);
    const isPerItem = edge.kind === EdgeKind.Launch && edge.launch?.items !== undefined;
    const candidates = candidatesOf(child, value);
    return [{ edge, child, ...(value === undefined ? {} : { value }), isPerItem, candidates }];
  });
}

/**
 * What a child node reads of the parent's scope, for the rules over the whole graph (reads,
 * provenance): every field of every start its edges may enter through — never required here, since
 * which start reads it is decided per edge (`rules/children.ts` checks the chosen start's fields).
 */
export function childFieldsOf(
  entries: readonly ChildEntry[],
  node: ComponentName,
): readonly ResolvedField[] {
  const fields = new Map<string, ResolvedField>();
  for (const entry of entries.filter((candidate) => candidate.edge.to === node))
    for (const start of entry.candidates)
      for (const field of start.fields) {
        const name = field.name === start.name ? start.name : `${start.name}.${field.name}`;
        fields.set(name, {
          name,
          label: `${node} (${name}: ${shapeLabel(field.shape)})`,
          shape: field.shape,
          slot: field.slot,
          isRequired: false,
          isList: field.isList,
          isPassThrough: false,
        });
      }
  return [...fields.values()];
}

/** The scopes an edge brings into the child, one per parent state and outdating step. */
function arrivingOf(dataflow: Dataflow, edge: FlowEdge): readonly ArrivingScope[] {
  return statesOf(dataflow, edge.from).flatMap((from) =>
    stepOf(edge, from.scope, dataflow.provenance).map((step) => ({ from, scope: step.scope })),
  );
}

/** A start's required fields, but the one the value fills, are current in every arriving scope. */
function othersOnPath(
  start: ChildStart,
  value: SlotKey | undefined,
  arriving: readonly ArrivingScope[],
): boolean {
  return start.fields
    .filter((field) => field.isRequired && field.slot !== value)
    .every((field) =>
      arriving.every(({ scope }) => slotOf(scope, field.slot).status === SlotStatus.Current),
    );
}

function choiceOf(entry: ChildEntry, arriving: readonly ArrivingScope[]): ChildChoice {
  const { candidates } = entry;
  const [only, second] = candidates;
  if (only === undefined) return { entry, choice: StartChoice.NoMatch, starts: [], arriving };
  if (second === undefined) return { entry, choice: StartChoice.Chosen, starts: [only], arriving };
  const value = entry.value === undefined ? undefined : slotOfValue(entry.value);
  const fitting = candidates.filter((start) => othersOnPath(start, value, arriving));
  const [chosen, other] = fitting;
  if (chosen !== undefined && other === undefined)
    return { entry, choice: StartChoice.Chosen, starts: [chosen], arriving };
  const starts = fitting.length > 1 ? fitting : candidates;
  return { entry, choice: StartChoice.Ambiguous, starts, arriving };
}

/** The start of every edge into a child, chosen on the scopes the data flow found. */
export function chooseStarts(
  entries: readonly ChildEntry[],
  dataflow: Dataflow,
): readonly ChildChoice[] {
  return entries.map((entry) => choiceOf(entry, arrivingOf(dataflow, entry.edge)));
}
