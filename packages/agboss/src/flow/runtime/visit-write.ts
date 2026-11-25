import type { UsageRecord } from "../../finops/usage.js";
import type { FlowEdge } from "../analyse/flow-graph.js";
import { OutputInvalidError } from "./errors.js";
import type { RuntimeNode } from "./graph-model.js";
import type { NodeOutcome } from "./node-runner.js";
import { writeAndOutdate, type OutdatingCascade } from "./outdating.js";
import { builtFromOf, type RuntimeProvenance } from "./provenance.js";
import type { OutdatedValueRecord, ScopeRecords } from "./records.js";
import { RouterDecisionError } from "./router-error.js";
import { recordsOfWrites } from "./scope.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import { visitNumberOf } from "./step-frame.js";
import type { VisitDeps } from "./visit.js";
import { recordOfNode } from "./workflow-keys.js";

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
  const read = { producer: node.id, read: outcome.read };
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

/** What a node gave with all that the visit spent: its own usage and what its code paid services. */
export type SpentOutcome = NodeOutcome & { readonly usage: readonly UsageRecord[] };

/** The branch of a `.toOneOf` / `.onFinish`: by the class the step gave, else by the finish a child ended at. */
function caseExitOf(node: RuntimeNode, outcome: NodeOutcome): FlowEdge {
  const variant = outcome.value?.variant ?? "";
  const branch = node.exits.cases.get(variant) ?? node.exits.cases.get(outcome.value?.finish ?? "");
  if (branch !== undefined) return branch;
  throw new OutputInvalidError({
    message: `${node.id} gave ${variant || "no class"}, which its .toOneOf([…]) has no branch for`,
  });
}

/** The edge a visit leaves by; `undefined` at a finish (the execution ends). */
export function exitOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: SpentOutcome,
  deps: VisitDeps,
): FlowEdge | undefined {
  const { exits } = node;
  if (outcome.route !== undefined) {
    const route = exits.routes.get(outcome.route);
    if (route !== undefined) return route;
    const visit = { nodeId: node.id, visitNumber: visitNumberOf(node, state) };
    const step = { ...visit, component: recordOfNode(deps, node.id) };
    const reason = `"${outcome.route}" is not one of its routes`;
    throw new RouterDecisionError({ ...step, reason, usage: outcome.usage });
  }
  if (exits.cases.size > 0) return caseExitOf(node, outcome);
  return exits.next;
}
