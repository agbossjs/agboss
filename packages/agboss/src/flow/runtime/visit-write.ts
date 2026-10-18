import type { FlowEdge } from "../analyse/flow-graph.js";
import type { RuntimeNode } from "./graph-model.js";
import type { NodeOutcome } from "./node-runner.js";
import { writeAndOutdate, type OutdatingCascade } from "./outdating.js";
import { builtFromOf, type RuntimeProvenance } from "./provenance.js";
import type { OutdatedValueRecord, ScopeRecords } from "./records.js";
import { recordsOfWrites } from "./scope.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";

/**
 * What a visit's way out writes (#271): its values, each built from what the step read (provenance),
 * into the scope — and, in the same step, the values they outdate out of it into `outdatedValues`.
 */
export interface VisitWrite {
  readonly update: Pick<ExecutionStateUpdate, "scope" | "outdatedValues">;
  /** What the write outdated (also in `update.outdatedValues`). */
  readonly outdated: readonly OutdatedValueRecord[];
  /** One per root trigger that outdated something (reported as events and trace entries). */
  readonly cascades: readonly OutdatingCascade[];
  /** The scope after the write; absent when the visit wrote nothing. */
  readonly scope?: ScopeRecords;
}

const NOTHING: VisitWrite = { update: {}, outdated: [], cascades: [] };

/** The write of one visit leaving by `exit` (none at a finish). */
export function visitWrite(
  node: RuntimeNode,
  state: ExecutionStateType,
  exit: FlowEdge | undefined,
  outcome: NodeOutcome,
  provenance: RuntimeProvenance,
): VisitWrite {
  if (exit === undefined) return NOTHING;
  const read = { producer: node.id, read: outcome.read, writes: exit.writes };
  const site = {
    node,
    visitNumber: (state.visits[node.id] ?? 0) + 1,
    builtFrom: builtFromOf(read, state.scope, provenance),
    scope: state.scope,
  };
  const given = outcome.value ?? { value: undefined };
  const written = recordsOfWrites(site, exit.writes, given);
  if (Object.keys(written).length === 0) return NOTHING;
  const result = writeAndOutdate(state.scope, written);
  return {
    update: { scope: result.scope, outdatedValues: [...result.outdated] },
    outdated: result.outdated,
    cascades: result.cascades,
    scope: result.scope,
  };
}
