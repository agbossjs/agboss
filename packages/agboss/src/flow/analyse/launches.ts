import type { ComponentName } from "../registry.js";
import { EdgeKind, type FlowEdge, type FlowLaunch, type JoinEdge, type ValueWrite } from "./flow-graph.js";
import { producersOfSlot } from "./join-groups.js";
import {
  isAboutWritten,
  outdate,
  readSlots,
  stepAlong,
  type OutdatingStep,
  type Provenance,
} from "./outdating.js";
import {
  afterWrites,
  slotOfDto,
  slotOfValue,
  slotOfWrite,
  type AbstractScope,
  type SlotKey,
} from "./scope.js";

/**
 * Launches in the data-flow engine (#273, #271 rule 10). A branch sees the scope at the launch —
 * the launching step's values written — plus, in a per-item run, its item as the latest single
 * `XDto` (a launch edge carries both). Its siblings' values enter the scope only at the join: the
 * join edge writes the launching step's values, then every value of the join at once, each built
 * from what its branches read at the launch (a per-item run counts as reading the list), and runs
 * one outdating cascade for them.
 */

/** The values of a join that its branches give together: one write per value, with its producers. */
interface GroupWrites {
  readonly producers: readonly ComponentName[];
  readonly writes: readonly ValueWrite[];
}

function groupWrites(join: JoinEdge): readonly GroupWrites[] {
  const byProducers = new Map<string, GroupWrites>();
  for (const write of join.values) {
    const producers = producersOfSlot(join.launch, join.groups, slotOfWrite(write));
    const key = producers.join(",");
    const found = byProducers.get(key);
    byProducers.set(key, { producers, writes: [...(found?.writes ?? []), write] });
  }
  return [...byProducers.values()];
}

/**
 * A list of several values of one class from one join counts them (#270): a single field of that
 * class then reads `[input.several-on-path]`, not a missing value.
 */
function countSeveral(scope: AbstractScope, join: JoinEdge): AbstractScope {
  const several = join.groups.filter((group) => group.isSeveral && scope.has(group.slot));
  if (several.length === 0) return scope;
  const next = new Map(scope);
  for (const { slot } of several) {
    const state = next.get(slot);
    if (state !== undefined) next.set(slot, { ...state, count: SEVERAL });
  }
  return next;
}

/** The count of a list of several values (any number above one). */
const SEVERAL = 2;

/** What a branch read at the launch: its fields' slots; a per-item run's item counts as its list. */
export function branchReads(
  atLaunch: AbstractScope,
  launch: FlowLaunch,
  branch: ComponentName,
  provenance: Provenance,
): readonly SlotKey[] {
  const read = readSlots(atLaunch, branch, provenance);
  const { items } = launch;
  if (items === undefined || typeof items.element !== "function") return read;
  const item = slotOfDto(items.element);
  return [...new Set([...read.filter((slot) => slot !== item), slotOfValue(items)])].sort();
}

/** What a value of the join is built from: what its branches read, `{ about }` respected. */
function builtFromOf(
  atLaunch: AbstractScope,
  launch: FlowLaunch,
  group: GroupWrites,
  provenance: Provenance,
): readonly SlotKey[] {
  const written = new Set(group.writes.map(slotOfWrite));
  const read = group.producers.flatMap((branch) => branchReads(atLaunch, launch, branch, provenance));
  return [...new Set(read)].filter((slot) => !isAboutWritten(atLaunch, slot, written)).sort();
}

interface Written {
  readonly scope: AbstractScope;
  readonly written: ReadonlySet<SlotKey>;
}

/** The join's values written over the scope at the launch, then their one cascade. */
function joinWrites(launched: OutdatingStep, join: JoinEdge, provenance: Provenance): readonly OutdatingStep[] {
  const atLaunch = launched.scope;
  let scopes: readonly Written[] = [{ scope: atLaunch, written: new Set() }];
  for (const group of groupWrites(join)) {
    const origin = { producers: group.producers, builtFrom: builtFromOf(atLaunch, join.launch, group, provenance) };
    scopes = scopes.flatMap((before) =>
      afterWrites(before.scope, group.writes, origin).map((after) => ({
        scope: countSeveral(after.scope, join),
        written: new Set([...before.written, ...after.written]),
      })),
    );
  }
  return scopes.map((after) => {
    const cascade = outdate(atLaunch, after.scope, after.written);
    return {
      scope: cascade.scope,
      causes: new Map([...launched.causes, ...cascade.causes]),
      replaced: new Set([...launched.replaced, ...cascade.replaced]),
    };
  });
}

/** Every scope an edge leads to: a join edge's values on top of its launching step's. */
export function stepOf(edge: FlowEdge, scope: AbstractScope, provenance: Provenance): readonly OutdatingStep[] {
  const launched = stepAlong(edge, scope, provenance);
  const { join } = edge;
  if (edge.kind !== EdgeKind.Join || join === undefined) return launched;
  return launched.flatMap((step) => joinWrites(step, join, provenance));
}

/** Every value a join writes, with the branches that give it (`[flow.unused-output]`, `{ about }`). */
export interface JoinValueWrite {
  readonly edge: FlowEdge;
  readonly write: ValueWrite;
  readonly producers: readonly ComponentName[];
}

export function joinValueWrites(edges: readonly FlowEdge[]): readonly JoinValueWrite[] {
  return edges.flatMap((edge) => {
    const { join } = edge;
    if (edge.kind !== EdgeKind.Join || join === undefined) return [];
    return join.values.map((write) => ({
      edge,
      write,
      producers: producersOfSlot(join.launch, join.groups, slotOfWrite(write)),
    }));
  });
}
