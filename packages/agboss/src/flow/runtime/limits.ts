import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { LimitExceededError, StepsLimitExceededError } from "../../graph/limits.js";
import { NodeKind } from "../ast.js";
import { CompensationEntryStatus } from "../compensation.js";
import { VisitsLimitExceededError } from "./errors.js";
import type { RuntimeNode } from "./graph-model.js";
import type { ExecutionStateType } from "./state.js";
import { startedVersionOf, type WorkflowIdentity } from "./step-frame.js";
import { plainRecordOf, type ComponentRecord } from "./records.js";

/**
 * What is checked before a step runs (#272 AC14, #261, #634): an agent's or a router's own
 * `maxVisits` and the steps of the execution (`maxSteps`) — counts of model steps only —, and the
 * execution's budgets and deadline before every step that can spend or reach out: an agent, a
 * router, an action, a child workflow (a recursion, a per-item child, a remote one), in a path or
 * as a branch of a launch. The counters are read anew, so the spend of the tenant's other
 * executions counts. Crossing any fails the visit before the node runs — no model call, no action,
 * no child — into that node's `.onError`, else the execution fails (its undo runs). Never checked:
 * a start and a finish (they spend nothing), an undo — automatic, or the undo action of a side path
 * closing an open entry — (it gives money back, Wiki → Rollback), and an action
 * of the side path that took a limit (`.onError(BudgetExceededError, toAction(…))`: the
 * application's reaction to it, which leads only to actions and finishes; what it spends counts).
 */

/** The limits one execution is held to: its workflow's steps and its budgets. */
export interface ExecutionLimits {
  readonly maxSteps: number;
  readonly budgets: BudgetMeter;
}

/** Agents and routers are steps; starts, actions and finishes are not. */
export const isWorkingNode = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || node.kind === NodeKind.Router;

/** Whether the execution took a limit on a side path: what follows is its reaction (actions only). */
const isPastLimit = (state: ExecutionStateType): boolean =>
  state.handledErrors.some(({ error }) => error.lineage.includes(LimitExceededError.code));

/** Whether this action undoes an open entry on a side path (#340): it gives money back. */
const isUndo = (state: ExecutionStateType, node: RuntimeNode): boolean =>
  state.compensations.some(
    (entry) => entry.status === CompensationEntryStatus.Open && entry.compensator === node.id,
  );

/** Whether the budgets hold this visit back: all but a start, a finish, an undo, a limit's reaction. */
const isBudgeted = (state: ExecutionStateType, node: RuntimeNode): boolean => {
  if (node.kind === NodeKind.Start || node.kind === NodeKind.Finish) return false;
  return node.kind !== NodeKind.Action || !(isPastLimit(state) || isUndo(state, node));
};

/** Throws the limit a visit of an agent or a router would cross: its visits, the steps. */
function checkSteps(
  state: ExecutionStateType,
  node: RuntimeNode,
  limits: ExecutionLimits,
  site: { readonly workflow: WorkflowIdentity; readonly component: ComponentRecord },
): void {
  const path = [...state.path, node.id];
  const spent = totalCost(state.usage);
  const visits = (state.visits[node.id] ?? 0) + 1;
  if (node.maxVisits !== undefined && visits > node.maxVisits) {
    throw new VisitsLimitExceededError(plainRecordOf(site.component), node.maxVisits, path, spent);
  }
  if (state.steps + 1 > limits.maxSteps) {
    const record = { ...site.workflow, startedVersion: startedVersionOf(state, site.workflow) };
    throw new StepsLimitExceededError(record, limits.maxSteps, path, spent);
  }
}

/**
 * Throws the limit a visit of this node would cross; resolves whether it runs as a step (an agent
 * or a router: it counts in `maxSteps`).
 */
export async function checkVisit(
  state: ExecutionStateType,
  node: RuntimeNode,
  limits: ExecutionLimits,
  workflow: WorkflowIdentity,
  component: ComponentRecord,
): Promise<boolean> {
  const isStep = isWorkingNode(node);
  if (isStep) checkSteps(state, node, limits, { workflow, component });
  if (!isBudgeted(state, node)) return isStep;
  await limits.budgets.refresh();
  limits.budgets.check(totalCost(state.usage), [...state.path, node.id]);
  return isStep;
}

/**
 * A step's service spend (`SpendRecorder`, #280 S43) under the step's name, counted in its budgets
 * the moment it is reported (#338): the branches running beside it see it at their next check.
 */
export function countedServiceSpend(
  limits: ExecutionLimits,
  node: RuntimeNode,
  path: readonly string[],
  record: UsageRecord,
): UsageRecord {
  const named = { ...record, caller: `${node.kind}:${node.id}` };
  limits.budgets.tally([named], [...path, node.id]);
  return named;
}
