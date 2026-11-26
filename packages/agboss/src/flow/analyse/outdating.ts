import { ComponentKind } from "../runtime/records.js";
import type { ComponentName } from "../registry.js";
import type { ResolvedField } from "./fields.js";
import type { FlowEdge, FlowGraph } from "./flow-graph.js";
import { twinSlotsOf } from "./slices.js";
import {
  afterWrites,
  slotOf,
  SlotStatus,
  type AbstractScope,
  type SlotKey,
  type SlotState,
} from "./scope.js";

/**
 * The abstract outdating step of #271 (S10), inside the one data-flow engine (#272 S10). Every
 * value remembers the slots its step read (`builtFrom`, rule 3): its `input` fields, or every
 * current value for an agent without `input` (rule 8). A write replaces its slots' older values;
 * every current value built from a replaced one becomes `Outdated`, then every value built from
 * those, until nothing changes. The new value itself is never outdated by the cascade it starts; what that
 * cascade outdated of its own sources leaves its `builtFrom`, since an outdated value never
 * outdates anything again.
 */

/** What the step needs to know of every producer. */
export interface Provenance {
  /** The fields each node reads. */
  readonly fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>;
  /** Agents without `input`: their value is built from every current value (rule 8). */
  readonly readsEverything: ReadonlySet<ComponentName>;
}

export function provenanceOf(
  graph: FlowGraph,
  fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>,
): Provenance {
  const readsEverything = new Set<ComponentName>();
  for (const node of graph.nodes.values()) {
    const { declaration } = node;
    if (declaration.kind === ComponentKind.Agent && declaration.options.input === undefined)
      readsEverything.add(node.name);
  }
  return { fields, readsEverything };
}

const isCurrent = (scope: AbstractScope, slot: SlotKey): boolean =>
  slotOf(scope, slot).status === SlotStatus.Current;

/**
 * The current slots a producer read in a scope: its fields (every slot for an agent without
 * `input`).
 */
export function readSlots(
  scope: AbstractScope,
  producer: ComponentName,
  provenance: Provenance,
): readonly SlotKey[] {
  const fields = provenance.readsEverything.has(producer)
    ? [...scope.keys()]
    : (provenance.fields.get(producer) ?? []).map((field) => field.slot);
  return [...new Set(fields.filter((slot) => isCurrent(scope, slot)))].sort();
}

/** One scope after a step: the outdated slots and, for each, the slot it was outdated through. */
export interface OutdatingStep {
  readonly scope: AbstractScope;
  /** Outdated slot → the replaced or outdated slot it was built from (the direct cause). */
  readonly causes: ReadonlyMap<SlotKey, SlotKey>;
  /** The written slots whose older value was current: the roots of the cascade. */
  readonly replaced: ReadonlySet<SlotKey>;
}

const outdated = (state: SlotState): SlotState => ({ ...state, status: SlotStatus.Outdated });

/**
 * A new value keeps only the sources still current after its write: a replaced or outdated source
 * can never start a cascade again, so the slot it was in no longer stands for what was read.
 */
function liveSources(scope: Map<SlotKey, SlotState>, written: ReadonlySet<SlotKey>): void {
  for (const slot of written) {
    const state = scope.get(slot);
    if (state === undefined) continue;
    const builtFrom = state.builtFrom.filter(
      (source) => !written.has(source) && isCurrent(scope, source),
    );
    scope.set(slot, { ...state, builtFrom });
  }
}

/** The twins of a written slot (#1288b) — the slices of a polymorphic list, the lists a slice is part of — are outdated by it. */
function outdateTwins(
  next: Map<SlotKey, SlotState>,
  written: ReadonlySet<SlotKey>,
  out: { readonly causes: Map<SlotKey, SlotKey>; readonly queue: SlotKey[] },
): void {
  for (const slot of written) {
    for (const twin of twinSlotsOf(slot, next.keys())) {
      const state = next.get(twin);
      if (written.has(twin) || state?.status !== SlotStatus.Current) continue;
      next.set(twin, outdated(state));
      out.causes.set(twin, slot);
      out.queue.push(twin);
    }
  }
}

/** The cascade of one write: `after` holds the new values in `written`; `before` the older ones. */
export function outdate(
  before: AbstractScope,
  after: AbstractScope,
  written: ReadonlySet<SlotKey>,
): OutdatingStep {
  const replaced = new Set([...written].filter((slot) => isCurrent(before, slot)));
  const next = new Map(after);
  const causes = new Map<SlotKey, SlotKey>();
  const queue = [...replaced];
  outdateTwins(next, written, { causes, queue });
  for (let cause = queue.shift(); cause !== undefined; cause = queue.shift()) {
    for (const [slot, state] of next) {
      if (written.has(slot) || state.status !== SlotStatus.Current) continue;
      if (!state.builtFrom.includes(cause)) continue;
      next.set(slot, outdated(state));
      causes.set(slot, cause);
      queue.push(slot);
    }
  }
  liveSources(next, written);
  return { scope: next, causes, replaced };
}

/** Every scope an edge leads to from `scope`: its writes, then their outdating. */
export function stepAlong(
  edge: FlowEdge,
  scope: AbstractScope,
  provenance: Provenance,
): readonly OutdatingStep[] {
  const origin = { producers: [edge.from], builtFrom: readSlots(scope, edge.from, provenance) };
  return afterWrites(scope, edge.writes, origin).map((write) =>
    outdate(scope, write.scope, write.written),
  );
}
