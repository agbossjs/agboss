import { NodeKind } from "../ast.js";
import type { ComponentName } from "../registry.js";
import type { UndoableAction } from "./compensation.js";
import { EdgeKind, outgoingEdges, type FlowEdge, type FlowGraph } from "./flow-graph.js";
import { launchLabel } from "./join-groups.js";

/**
 * The paths of a workflow with its undoable actions open (#339): a breadth-first walk over
 * (node, open actions, side paths entered), so the first path found to a state is a shortest one.
 * An undoable action opens when it succeeds (any edge but its `.onError`), and closes when its
 * committing action succeeds or its undo action runs (whether the undo then succeeds or not — a
 * failed undo is the side path's own `.onError`). Entering an `.onError` / `.onJoinError` side path
 * records the actions open there: they must be undone, newest first, before a finish. A join opens
 * the launch's undoable action branches; a failed join's finished branches are undone
 * automatically (#340), so its side path owes only what was open before the launch.
 */

/** A side path entered with undoable actions open. */
export interface SidePathEntry {
  /** `.onError(StepFailedError, …) side path after offer-letter-agent`. */
  readonly label: string;
  readonly node: ComponentName;
  /** The actions open when it was entered, newest first. */
  readonly owed: readonly ComponentName[];
}

export enum CompensationFindingKind {
  Uncompensated = "uncompensated",
  Uncommitted = "uncommitted",
  OutOfOrder = "out-of-order",
}

export type CompensationFinding =
  | {
      readonly kind: CompensationFindingKind.Uncompensated;
      readonly sidePath: SidePathEntry;
      readonly finish: ComponentName;
      /** The actions still open, newest first. */
      readonly missing: readonly ComponentName[];
    }
  | {
      readonly kind: CompensationFindingKind.Uncommitted;
      readonly action: ComponentName;
      readonly finish: ComponentName;
      readonly path: readonly ComponentName[];
    }
  | {
      readonly kind: CompensationFindingKind.OutOfOrder;
      /** The older action, undone first. */
      readonly older: ComponentName;
      /** The newer one, undone after it. */
      readonly newer: ComponentName;
      readonly path: readonly ComponentName[];
    };

/** An older action undone while a newer one was still open: `[older, newer]`. */
type EarlyUndo = readonly [ComponentName, ComponentName];

interface WalkState {
  readonly node: ComponentName;
  /** Oldest first. */
  readonly open: readonly ComponentName[];
  readonly sidePaths: readonly SidePathEntry[];
  readonly earlyUndos: readonly EarlyUndo[];
  readonly path: readonly ComponentName[];
}

/** Past this many states the walk stops: what it found so far is reported. */
const MAX_STATES = 20_000;

type Undoables = ReadonlyMap<ComponentName, UndoableAction>;

const stateKey = (state: WalkState): string =>
  JSON.stringify([
    state.node,
    state.open,
    state.sidePaths.map((entry) => [entry.label, entry.owed]),
    [...state.earlyUndos].map((pair) => pair.join(">")).sort(),
  ]);

/** Closes `action`, dropping what only it kept: early undos and side paths that owe nothing more. */
function closing(state: WalkState, action: ComponentName): WalkState {
  const open = state.open.filter((name) => name !== action);
  return {
    ...state,
    open,
    earlyUndos: state.earlyUndos.filter((pair) => pair[0] !== action && pair[1] !== action),
    sidePaths: state.sidePaths.filter((entry) => entry.owed.some((name) => open.includes(name))),
  };
}

/** The undo action `state.node` runs: it closes the newest open action it undoes. */
function undoing(state: WalkState, undoables: Undoables, found: CompensationFinding[]): WalkState {
  const target = state.open.findLast((name) => undoables.get(name)?.compensator === state.node);
  if (target === undefined) return state;
  for (const [older] of state.earlyUndos.filter((pair) => pair[1] === target))
    found.push({
      kind: CompensationFindingKind.OutOfOrder,
      older,
      newer: target,
      path: state.path,
    });
  const newer = state.open.slice(state.open.indexOf(target) + 1);
  const early = newer.map((name): EarlyUndo => [target, name]);
  const closed = closing(state, target);
  return { ...closed, earlyUndos: [...closed.earlyUndos, ...early] };
}

/** What a finish owes: the side paths' open actions, and the open actions a committer commits. */
function finishing(state: WalkState, undoables: Undoables, found: CompensationFinding[]): void {
  const owed = new Set<ComponentName>();
  for (const sidePath of state.sidePaths) {
    const missing = sidePath.owed.filter((name) => state.open.includes(name));
    missing.forEach((name) => owed.add(name));
    if (missing.length > 0)
      found.push({
        kind: CompensationFindingKind.Uncompensated,
        sidePath,
        finish: state.node,
        missing,
      });
  }
  for (const action of state.open.filter((name) => !owed.has(name))) {
    if (undoables.get(action)?.committer === undefined) continue;
    found.push({
      kind: CompensationFindingKind.Uncommitted,
      action,
      finish: state.node,
      path: state.path,
    });
  }
}

const opening = (state: WalkState, action: ComponentName, undoables: Undoables): WalkState =>
  undoables.has(action)
    ? { ...state, open: [...state.open.filter((name) => name !== action), action] }
    : state;

function sidePathLabel(edge: FlowEdge): string {
  const error = edge.error?.name ?? "Error";
  return edge.kind === EdgeKind.Error || edge.launch === undefined
    ? `.onError(${error}, …) side path after ${edge.from}`
    : `.onJoinError(${error}, …) side path after the join of ${launchLabel(edge.launch)}`;
}

/** Leaving `state.node` along `edge`: what succeeded opens or commits, a side path owes the rest. */
function leaving(state: WalkState, edge: FlowEdge, undoables: Undoables): WalkState {
  let next = state;
  if (edge.kind !== EdgeKind.Error) {
    next = opening(next, state.node, undoables);
    for (const action of next.open.filter((name) => undoables.get(name)?.committer === state.node))
      next = closing(next, action);
  }
  if (edge.kind === EdgeKind.Join)
    for (const branch of edge.launch?.branches ?? []) next = opening(next, branch.node, undoables);
  if ((edge.kind === EdgeKind.Error || edge.kind === EdgeKind.JoinError) && next.open.length > 0) {
    const entry = { label: sidePathLabel(edge), node: state.node, owed: [...next.open].reverse() };
    next = { ...next, sidePaths: [...next.sidePaths, entry] };
  }
  return { ...next, node: edge.to, path: [...next.path, edge.to] };
}

/** Every finding of the walk, in the order found. */
export function walkCompensations(
  graph: FlowGraph,
  undoables: Undoables,
): readonly CompensationFinding[] {
  const found: CompensationFinding[] = [];
  if (undoables.size === 0) return found;
  const edges = outgoingEdges(graph);
  const seen = new Set<string>();
  const queue: WalkState[] = graph.starts.map((node) => ({
    node,
    open: [],
    sidePaths: [],
    earlyUndos: [],
    path: [node],
  }));
  for (let arrived = queue.shift(); arrived !== undefined; arrived = queue.shift()) {
    if (seen.has(stateKey(arrived)) || seen.size >= MAX_STATES) continue;
    seen.add(stateKey(arrived));
    const state = undoing(arrived, undoables, found);
    if (graph.nodes.get(state.node)?.kind === NodeKind.Finish) finishing(state, undoables, found);
    for (const edge of edges.get(state.node) ?? [])
      if (edge.kind !== EdgeKind.Launch) queue.push(leaving(state, edge, undoables));
  }
  return found;
}
