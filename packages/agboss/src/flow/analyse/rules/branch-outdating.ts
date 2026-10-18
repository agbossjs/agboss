import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentName } from "../../registry.js";
import { statesOf } from "../dataflow.js";
import { EdgeKind, type FlowEdge, type JoinEdge, type ValueWrite } from "../flow-graph.js";
import { launchLabel, producersOfSlot } from "../join-groups.js";
import { shapeLabel } from "../labels.js";
import { branchReads } from "../launches.js";
import { stepAlong } from "../outdating.js";
import {
  aboutOfWrite,
  slotOf,
  slotOfWrite,
  SlotStatus,
  writtenValue,
  type AbstractScope,
  type SlotKey,
} from "../scope.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[launch.branch-outdates-sibling]` (#271 rule 10, S13, AC9): at the join of a launch, a branch that
 * writes a new value into a slot another branch of the same launch read — directly or through what
 * the values it read were built from — would bring that branch's result to the join already
 * outdated. Checked at the join itself, whether anything reads the outdated value later or not. A
 * per-item launch and the copies of one agent never trigger it: their join writes one list slot,
 * which no branch read.
 */

/** What a branch's value depends on at the launch: what it read, and what those were built from. */
function dependsOn(atLaunch: AbstractScope, seeds: readonly SlotKey[]): ReadonlySet<SlotKey> {
  const seen = new Set<SlotKey>(seeds);
  const queue = [...seeds];
  for (let slot = queue.shift(); slot !== undefined; slot = queue.shift()) {
    for (const source of slotOf(atLaunch, slot).builtFrom) {
      if (seen.has(source)) continue;
      seen.add(source);
      queue.push(source);
    }
  }
  return seen;
}

/** One value of the join, and who gives it. */
interface JoinValue {
  readonly write: ValueWrite;
  readonly producers: readonly ComponentName[];
}

const valueLabel = (write: ValueWrite): string => shapeLabel(writtenValue(write.shape).value);

function siblingViolations(
  join: JoinEdge,
  atLaunch: AbstractScope,
  context: AnalysisContext,
): readonly RuleViolation[] {
  const values: readonly JoinValue[] = join.values.map((write) => ({
    write,
    producers: producersOfSlot(join.launch, join.groups, slotOfWrite(write)),
  }));
  const { provenance } = context.dataflow;
  return values.flatMap((renewing) =>
    values
      .filter((outdated) => outdated.producers.every((node) => !renewing.producers.includes(node)))
      .flatMap((outdated) => {
        const seeds = outdated.producers.flatMap((branch) => [
          ...branchReads(atLaunch, join.launch, branch, provenance),
          ...aboutOfWrite(outdated.write),
        ]);
        const slot = slotOfWrite(renewing.write);
        const isRenewal = slotOf(atLaunch, slot).status === SlotStatus.Current;
        if (!isRenewal || !dependsOn(atLaunch, seeds).has(slot)) return [];
        const writer = renewing.producers.join(", ");
        const reader = outdated.producers.join(", ");
        const message =
          `${writer} returns ${valueLabel(renewing.write)}, which ${reader} of the same launch was built from: ` +
          `${reader}'s ${valueLabel(outdated.write)} is outdated at the join of ${launchLabel(join.launch)}`;
        return [
          violation("launch.branch-outdates-sibling", message, [
            ...renewing.producers,
            ...outdated.producers,
          ]),
        ];
      }),
  );
}

function joinViolations(
  context: AnalysisContext,
  edge: FlowEdge,
  join: JoinEdge,
): readonly RuleViolation[] {
  const { provenance } = context.dataflow;
  return statesOf(context.dataflow, edge.from).flatMap((state) =>
    stepAlong(edge, state.scope, provenance).flatMap((launched) =>
      siblingViolations(join, launched.scope, context),
    ),
  );
}

export function branchOutdatingRules(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const edge of context.graph.edges) {
    if (edge.kind !== EdgeKind.Join || edge.join === undefined) continue;
    for (const problem of joinViolations(context, edge, edge.join))
      found.set(problem.message, problem);
  }
  return [...found.values()];
}
