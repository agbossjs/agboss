import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentName } from "../../registry.js";
import { statesOf } from "../dataflow.js";
import { EdgeKind, type FlowGraph, type ValueWrite } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { joinValueWrites } from "../launches.js";
import { readSlots } from "../outdating.js";
import {
  aboutOfWrite,
  slotLabel,
  slotOf,
  slotOfWrite,
  SlotStatus,
  type SlotKey,
} from "../scope.js";
import { isCycle, stronglyConnected } from "../strongly-connected.js";
import type { AnalysisContext } from "./context.js";

/**
 * The direction of a cycle (#271 rule 5, AC4): when the classes written in a cycle of the flow are
 * built from each other (the writer reads the reviewer's notes, the reviewer reads the writer's
 * draft), the flow states what one of the answers is about — `.returns(CritiqueDto, { about:
 * DraftDto })` or, for a `oneOf`, `caseOf(DraftChangesDto, { about: DraftDto })` (#299 S54). A
 * strongly connected component of the "built from" graph between classes with no `about` edge →
 * `[io.ambiguous-cycle]`, the hint naming the step to write it on. A producer whose values are
 * `{ about: T }` and that reads `T` in two or more fields → `[io.ambiguous-about]` (#271 S14 after
 * #299 S56: without tags, two values of `T` are read only as `historyOf(T)`, whose `current` is what
 * the answers are about). Outside cycles nothing is written.
 */

/** A written class built from a read one, by a producer. */
interface BuiltFromEdge {
  readonly from: SlotKey;
  readonly to: SlotKey;
  readonly producer: ComponentName;
  /** What the written value is about (`{ about }`). */
  readonly about: readonly SlotKey[];
  /** Written by a `caseOf(…)`: its `{ about }` goes on the case. */
  readonly isCase: boolean;
  /** Written by a join (#273): its `{ about }` goes on `.join().returns(…)`, after this launch. */
  readonly join?: string;
}

/** A value a producer writes: on an edge from it, or as a branch of a join (#273). */
interface ProducedWrite {
  readonly write: ValueWrite;
  readonly join?: string;
}

/** What each producer writes: its edges' values (not a launch edge's item) and its join values. */
function producedWrites(
  context: AnalysisContext,
): ReadonlyMap<ComponentName, readonly ProducedWrite[]> {
  const byProducer = new Map<ComponentName, ProducedWrite[]>();
  const add = (producer: ComponentName, produced: ProducedWrite): void => {
    byProducer.set(producer, [...(byProducer.get(producer) ?? []), produced]);
  };
  for (const edge of context.graph.edges) {
    if (edge.kind === EdgeKind.Launch) continue;
    for (const write of edge.writes) add(edge.from, { write });
  }
  for (const { edge, write, producers } of joinValueWrites(context.graph.edges)) {
    const join = edge.launch === undefined ? edge.from : launchLabel(edge.launch);
    for (const producer of producers) add(producer, { write, join });
  }
  return byProducer;
}

/** The producers of a cycle: its nodes, and the branches of the launches its nodes join. */
function producersOf(
  context: AnalysisContext,
  cycle: readonly ComponentName[],
): readonly ComponentName[] {
  const branches = context.graph.edges
    .filter(
      (edge) => edge.kind === EdgeKind.Join && cycle.includes(edge.from) && cycle.includes(edge.to),
    )
    .flatMap((edge) => edge.launch?.branches.map((branch) => branch.node) ?? []);
  return [...new Set([...cycle, ...branches])];
}

/** What the producers of a cycle build from what, over every scope that reaches them. */
function builtFromEdges(
  context: AnalysisContext,
  nodes: readonly ComponentName[],
): readonly BuiltFromEdge[] {
  const { dataflow } = context;
  const produced = producedWrites(context);
  const edges = new Map<string, BuiltFromEdge>();
  for (const producer of producersOf(context, nodes)) {
    for (const state of statesOf(dataflow, producer)) {
      const read = readSlots(state.scope, producer, dataflow.provenance);
      for (const { write, join } of produced.get(producer) ?? []) {
        const from = slotOfWrite(write);
        const about = aboutOfWrite(write);
        const targets = about.filter(
          (slot) => slotOf(state.scope, slot).status === SlotStatus.Current,
        );
        for (const to of [...new Set([...read, ...targets])].filter((slot) => slot !== from)) {
          const { isCase } = write;
          edges.set(`${from}|${to}|${producer}|${about.join("+")}`, {
            from,
            to,
            producer,
            about,
            isCase,
            ...(join === undefined ? {} : { join }),
          });
        }
      }
    }
  }
  return [...edges.values()];
}

/** The class of a cycle the shortest path writes first: what the others' answers are about. */
function firstWritten(context: AnalysisContext, slots: readonly SlotKey[]): SlotKey | undefined {
  const depths = slots.map((slot) => {
    const depthsOfSlot = [...context.dataflow.scopes.values()].flatMap((scopes) =>
      [...scopes.states.values()]
        .filter((state) => slotOf(state.scope, slot).status !== SlotStatus.Absent)
        .map((state) => state.depth),
    );
    return { slot, depth: Math.min(...depthsOfSlot) };
  });
  return [...depths].sort((first, second) => first.depth - second.depth)[0]?.slot;
}

function hintOf(
  context: AnalysisContext,
  slots: readonly SlotKey[],
  edges: readonly BuiltFromEdge[],
): string {
  const target = firstWritten(context, slots);
  const [edge] = edges
    .filter((candidate) => candidate.to === target && slots.includes(candidate.from))
    .sort((first, second) => first.producer.localeCompare(second.producer));
  if (target === undefined || edge === undefined)
    return "write { about } on one of the values in the flow";
  const value = slotLabel(edge.from);
  const about = `{ about: ${slotLabel(target)} }`;
  if (edge.join !== undefined)
    return `write .join().returns(${value}, ${about}) after ${edge.join}`;
  return edge.isCase
    ? `write caseOf(${value}, ${about}) after ${edge.producer}`
    : `write .returns(${value}, ${about}) after ${edge.producer}`;
}

function cycleViolations(
  context: AnalysisContext,
  cycle: readonly ComponentName[],
): readonly RuleViolation[] {
  const edges = builtFromEdges(context, cycle);
  const slots = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort();
  const successors = (slot: SlotKey): readonly SlotKey[] =>
    edges.filter((edge) => edge.from === slot).map((edge) => edge.to);
  return stronglyConnected(slots, successors)
    .filter((classes) => classes.length > 1)
    .filter((classes) =>
      edges.every(
        (edge) =>
          !classes.includes(edge.from) || !edge.about.some((target) => classes.includes(target)),
      ),
    )
    .map((classes) => {
      const producers = [
        ...new Set(
          edges.filter((edge) => classes.includes(edge.from)).map((edge) => edge.producer),
        ),
      ].sort();
      const message =
        `${classes.map(slotLabel).join(", ")} are built from each other in the cycle through ` +
        `${cycle.join(", ")} — say what the answers are about: ${hintOf(context, classes, edges)}`;
      return violation("io.ambiguous-cycle", message, producers);
    });
}

/** The cycles of the flow: its strongly connected components that loop. */
function flowCycles(context: AnalysisContext): readonly (readonly ComponentName[])[] {
  const { graph } = context;
  const successors = (node: ComponentName): readonly ComponentName[] =>
    graph.edges.filter((edge) => edge.from === node).map((edge) => edge.to);
  return stronglyConnected([...graph.nodes.keys()], successors).filter((component) =>
    isCycle(component, successors),
  );
}

/** The slots each producer's values are about, over every `{ about }` it is written with. */
export function aboutTargetsOf(graph: FlowGraph): ReadonlyMap<ComponentName, ReadonlySet<SlotKey>> {
  const targets = new Map<ComponentName, Set<SlotKey>>();
  const add = (producer: ComponentName, slots: readonly SlotKey[]): void => {
    const own = targets.get(producer) ?? new Set<SlotKey>();
    for (const slot of slots) own.add(slot);
    if (own.size > 0) targets.set(producer, own);
  };
  for (const edge of graph.edges) add(edge.from, edge.writes.flatMap(aboutOfWrite));
  for (const { write, producers } of joinValueWrites(graph.edges))
    for (const producer of producers) add(producer, aboutOfWrite(write));
  return targets;
}

/** A producer whose values are `{ about: T }` reading `T` in two or more fields (S14, S56). */
function aboutViolations(context: AnalysisContext): readonly RuleViolation[] {
  return [...aboutTargetsOf(context.graph)].flatMap(([node, targets]) =>
    [...targets].sort().flatMap((target) => {
      const fields = (context.fields.get(node) ?? []).filter((field) => field.slot === target);
      if (fields.length < 2) return [];
      const label = slotLabel(target);
      const message =
        `${node} reads ${String(fields.length)} ${label} fields (${fields.map((field) => field.name).join(", ")}) ` +
        `and its values are { about: ${label} } — about which one? Read ${label} in one field: with ` +
        `historyOf(${label}) the answers are about its current value`;
      return [violation("io.ambiguous-about", message, [node])];
    }),
  );
}

export function aboutRules(context: AnalysisContext): readonly RuleViolation[] {
  const cycles = new Map<string, RuleViolation>();
  // past the scope guard the states are incomplete: `[flow.analysis-too-large]` says so instead
  const isComplete = [...context.dataflow.scopes.values()].every((scopes) => !scopes.isTooLarge);
  for (const cycle of isComplete ? flowCycles(context) : []) {
    for (const found of cycleViolations(context, cycle)) cycles.set(found.message, found);
  }
  return [...cycles.values(), ...aboutViolations(context)];
}
