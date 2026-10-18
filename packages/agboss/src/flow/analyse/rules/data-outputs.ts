import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentName } from "../../registry.js";
import { statesOf } from "../dataflow.js";
import { EdgeKind, type ValueWrite } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { joinValueWrites } from "../launches.js";
import { shapeLabel } from "../labels.js";
import { slotOf, slotOfValue, slotOfWrite, SlotStatus, type SlotKey } from "../scope.js";
import type { AnalysisContext } from "./context.js";

/**
 * Reaching definitions on the same abstract scopes (#270 AC7, AC19): every `.returns(T)` must reach,
 * on at least one path, a node that reads it before a newer value overwrites it, else
 * `[flow.unused-output]` (a dead store fails; a value read on one path and overwritten unread on
 * another passes). A value is identified by its producer and slot — one class is one node, so a
 * producer returns in one place. `caseOf(XDto)` is a read (the switch chose by it).
 */

/** `producer|slot`: which value was read. */
const readKey = (producer: ComponentName, slot: SlotKey): string => `${producer}|${slot}`;

/** Every value some field read on some reachable scope; a per-item launch reads its list. */
function collectReads(context: AnalysisContext): ReadonlySet<string> {
  const reads = new Set<string>();
  for (const launch of context.walked.launches)
    if (launch.items !== undefined) reads.add(readKey(launch.launcher, slotOfValue(launch.items)));
  for (const [node, fields] of context.fields) {
    for (const state of statesOf(context.dataflow, node)) {
      for (const field of fields) {
        const slot = slotOf(state.scope, field.slot);
        if (slot.status === SlotStatus.Absent) continue;
        for (const producer of slot.producers) reads.add(readKey(producer, field.slot));
      }
    }
  }
  return reads;
}

/** One value a step (or the branches of a join) returned, and who returned it. */
interface ReturnedWrite {
  readonly write: ValueWrite;
  readonly producers: readonly ComponentName[];
  /** How the message names who returned it: `planner-agent`, `the join of …`. */
  readonly label: string;
}

/** The edges a step's own values leave by: its next step, and its join (#273). */
const RETURNING: ReadonlySet<EdgeKind> = new Set([EdgeKind.Next, EdgeKind.Join]);

function returnedValues(context: AnalysisContext): readonly ReturnedWrite[] {
  const reached = context.graph.edges.filter((edge) => context.dataflow.scopes.has(edge.from));
  const own = reached
    .filter((edge) => RETURNING.has(edge.kind))
    .flatMap((edge) =>
      edge.writes
        .filter((write) => !write.isCase)
        .map((write) => ({ write, producers: [edge.from], label: edge.from })),
    );
  const joined = joinValueWrites(reached).map(({ edge, write, producers }) => ({
    write,
    producers,
    label: edge.launch === undefined ? edge.from : `the join of ${launchLabel(edge.launch)}`,
  }));
  return [...own, ...joined];
}

function valueViolations(
  value: ReturnedWrite,
  reads: ReadonlySet<string>,
): readonly RuleViolation[] {
  const { write, producers, label } = value;
  const slot = slotOfWrite(write);
  if (producers.some((producer) => reads.has(readKey(producer, slot)))) return [];
  const message = `${label} returns ${shapeLabel(write.shape)} that no node reads — read it in a node below, or remove it`;
  return [violation("flow.unused-output", message, [...producers])];
}

export function dataOutputRules(context: AnalysisContext): readonly RuleViolation[] {
  // past the scope guard the reads are incomplete: `[flow.analysis-too-large]` says so instead
  if ([...context.dataflow.scopes.values()].some((scopes) => scopes.isTooLarge)) return [];
  const reads = collectReads(context);
  const found = new Map<string, RuleViolation>();
  for (const value of returnedValues(context)) {
    for (const problem of valueViolations(value, reads))
      found.set(`${problem.code}|${problem.message}`, problem);
  }
  return [...found.values()];
}
