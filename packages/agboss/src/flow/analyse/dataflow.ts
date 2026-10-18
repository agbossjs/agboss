import type { ComponentName } from "../registry.js";
import type { ResolvedField } from "./fields.js";
import { outgoingEdges, type FlowGraph } from "./flow-graph.js";
import { stepOf } from "./launches.js";
import { provenanceOf, type Provenance } from "./outdating.js";
import { EMPTY_SCOPE, scopeKey, type AbstractScope } from "./scope.js";

/**
 * The one data-flow engine of the path rules (#272 S10): every node keeps the **set** of abstract
 * scopes that reach it, iterated to a fixed point. The worklist is breadth-first over
 * (node, abstract scope) from the starts, so the first way a state is found is a shortest one — the
 * witness path a message names. Every write runs the outdating step of #271 (`outdating.ts`). The
 * domain is finite (slots × status × producers × built-from), so the iteration ends; `maxVisits`
 * takes no part (a graph wrong on any iteration is wrong).
 */

/** More abstract scopes than this at one node → `[flow.analysis-too-large]` (S10). */
export const MAX_SCOPES_PER_NODE = 4096;

/** Where a state was found from: the node before and its state. */
export interface ScopeRef {
  readonly node: ComponentName;
  readonly key: string;
}

export interface ScopeState {
  readonly scope: AbstractScope;
  readonly key: string;
  /** Edges from a start on the shortest way here. */
  readonly depth: number;
  readonly parent?: ScopeRef;
}

export interface NodeScopes {
  /** In the order found (breadth-first: by depth). */
  readonly states: ReadonlyMap<string, ScopeState>;
  /** More scopes reached the node than `MAX_SCOPES_PER_NODE`; the rest were not explored. */
  readonly isTooLarge: boolean;
  /** The first scope past the limit (it shows which slots multiply the scopes). */
  readonly rejected?: AbstractScope;
}

/** A node's scopes while the engine runs. */
interface GrowingScopes {
  readonly states: Map<string, ScopeState>;
  isTooLarge: boolean;
  rejected?: AbstractScope;
}

export interface Dataflow {
  /** Every node reached from a start; an unreachable node has no entry. */
  readonly scopes: ReadonlyMap<ComponentName, NodeScopes>;
  /** What every producer's values are built from (the outdating step reads it). */
  readonly provenance: Provenance;
}

class Worklist {
  readonly scopes = new Map<ComponentName, GrowingScopes>();
  private readonly queue: ScopeRef[] = [];
  private next = 0;

  add(node: ComponentName, scope: AbstractScope, depth: number, parent?: ScopeRef): void {
    const entry: GrowingScopes = this.scopes.get(node) ?? { states: new Map(), isTooLarge: false };
    this.scopes.set(node, entry);
    const key = scopeKey(scope);
    if (entry.states.has(key)) return;
    if (entry.states.size >= MAX_SCOPES_PER_NODE) {
      entry.isTooLarge = true;
      entry.rejected ??= scope;
      return;
    }
    entry.states.set(
      key,
      parent === undefined ? { scope, key, depth } : { scope, key, depth, parent },
    );
    this.queue.push({ node, key });
  }

  take(): ScopeRef | undefined {
    const ref = this.queue[this.next];
    this.next += 1;
    return ref;
  }

  state(ref: ScopeRef): ScopeState | undefined {
    return this.scopes.get(ref.node)?.states.get(ref.key);
  }
}

/** Runs the engine to its fixed point. */
export function runDataflow(
  graph: FlowGraph,
  fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>,
): Dataflow {
  const edges = outgoingEdges(graph);
  const provenance = provenanceOf(graph, fields);
  const worklist = new Worklist();
  for (const start of graph.starts) worklist.add(start, EMPTY_SCOPE, 0);
  for (let ref = worklist.take(); ref !== undefined; ref = worklist.take()) {
    const state = worklist.state(ref);
    if (state === undefined) continue;
    for (const edge of edges.get(ref.node) ?? []) {
      for (const step of stepOf(edge, state.scope, provenance)) {
        worklist.add(edge.to, step.scope, state.depth + 1, ref);
      }
    }
  }
  return { scopes: worklist.scopes, provenance };
}

/** One step of a witness: the node and the state it was reached with. */
export interface WitnessStep {
  readonly node: ComponentName;
  readonly state: ScopeState;
}

/** The shortest way from a start to a state, step by step, the start first. */
export function witnessSteps(dataflow: Dataflow, at: ScopeRef): readonly WitnessStep[] {
  const steps: WitnessStep[] = [];
  for (let ref: ScopeRef | undefined = at; ref !== undefined;) {
    const state: ScopeState | undefined = dataflow.scopes.get(ref.node)?.states.get(ref.key);
    if (state === undefined) break;
    steps.unshift({ node: ref.node, state });
    ref = state.parent;
  }
  return steps;
}

/** The shortest path from a start to a state: the node names, the start first. */
export const witnessPath = (dataflow: Dataflow, at: ScopeRef): readonly ComponentName[] =>
  witnessSteps(dataflow, at).map((step) => step.node);

/** The states of a node, shallowest first. */
export const statesOf = (dataflow: Dataflow, node: ComponentName): readonly ScopeState[] => [
  ...(dataflow.scopes.get(node)?.states.values() ?? []),
];
