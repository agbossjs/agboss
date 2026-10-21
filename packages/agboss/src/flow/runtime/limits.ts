import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { StepsLimitExceededError } from "../../graph/limits.js";
import { NodeKind } from "../ast.js";
import { VisitsLimitExceededError } from "./errors.js";
import type { RuntimeNode } from "./graph-model.js";
import type { ExecutionStateType } from "./state.js";
import { startedVersionOf, type WorkflowIdentity } from "./step-frame.js";
import { plainRecordOf, type ComponentRecord } from "./records.js";

/**
 * What is checked before an agent or a router runs (#272 AC14, #261): the node's own `maxVisits`,
 * the steps of the execution (`maxSteps`), and every budget of the execution — its counters read
 * anew, so the spend of the tenant's other executions counts. Crossing any fails the visit before
 * the node runs — no model call — into that node's `.onError`, else the execution fails.
 */

/** The limits one execution is held to: its workflow's steps and its budgets. */
export interface ExecutionLimits {
  readonly maxSteps: number;
  readonly budgets: BudgetMeter;
}

/** Agents and routers are steps; starts, actions and finishes are not. */
export const isWorkingNode = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || node.kind === NodeKind.Router;

/** Throws the limit a visit of this working node would cross. */
export async function checkVisit(
  state: ExecutionStateType,
  node: RuntimeNode,
  limits: ExecutionLimits,
  workflow: WorkflowIdentity,
  component: ComponentRecord,
): Promise<void> {
  const path = [...state.path, node.id];
  const spent = totalCost(state.usage);
  const visits = (state.visits[node.id] ?? 0) + 1;
  if (node.maxVisits !== undefined && visits > node.maxVisits) {
    throw new VisitsLimitExceededError(plainRecordOf(component), node.maxVisits, path, spent);
  }
  if (state.steps + 1 > limits.maxSteps) {
    const record = { ...workflow, startedVersion: startedVersionOf(state, workflow) };
    throw new StepsLimitExceededError(record, limits.maxSteps, path, spent);
  }
  await limits.budgets.refresh();
  limits.budgets.check(spent, path);
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
