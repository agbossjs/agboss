import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import type { ErrorRecord } from "../../core/error-record.js";
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
 * closing an entry open when the side path was entered — (it gives money back, Wiki → Rollback),
 * and an action of the side path that took a limit (`.onError(BudgetExceededError, toAction(…))`:
 * the application's reaction to it, which leads only to actions and finishes; what it spends
 * counts). Both only on the side path itself (#656, `SidePathRecord` below): a launch ends it — its branches
 * and what follows its join are held back —, and the same action reached any other way is a step.
 * Such a step held back while it is some open entry's undo, its `.onError` taking the error, still
 * gives the money back: the entry is undone as an undo (#675, `compensation/held-undo.ts`).
 */

/**
 * The side path an execution is on (#656), as the budgets' two exemptions read it: entered when an
 * `.onError` / `.onJoinError` takes a failure, it is the one visit it leads to — and, step by step,
 * the visit each of its visits leads to. Every visit of a node writes it anew — the next visit
 * when the visit was on it and goes on to one node, else none —, so it ends at a finish and at a
 * launch (its branches and whatever follows its join are off it), and a visit off it never takes
 * it up again. It lives in the execution's checkpointed state: the visit run again after a resume,
 * a recovery or a takeover reads what the first run read, and nothing after it inherits it.
 */
export interface SidePathRecord {
  /** The node of the next visit on it. */
  readonly next: string;
  /** Whether it took a limit (or leads on from a side path that did): its actions run past the budgets. */
  readonly isAfterLimit: boolean;
  /** The keys of the entries open when it was entered: the undos it owes (#340). */
  readonly owed: readonly string[];
}

/** The side path `node`'s visit is on; `undefined` off any side path. */
export const sidePathOf = (
  state: ExecutionStateType,
  node: RuntimeNode,
): SidePathRecord | undefined =>
  state.sidePath !== null && state.sidePath.next === node.id ? state.sidePath : undefined;

/** Whether the failure is a limit (its lineage holds `LimitExceededError`). */
const isLimit = (error: ErrorRecord): boolean => error.lineage.includes(LimitExceededError.code);

/**
 * The side path an `.onError` / `.onJoinError` takes the failure into, to `to`: after a limit when
 * the failure is one or the failed visit was on such a side path (its reaction's own error); it owes
 * the undos of every entry open now.
 */
export function sidePathEntered(
  state: ExecutionStateType,
  error: ErrorRecord,
  to: string,
  from?: RuntimeNode,
): { readonly sidePath: SidePathRecord } {
  const on = from === undefined ? undefined : sidePathOf(state, from);
  const owed = state.compensations
    .filter((entry) => entry.status === CompensationEntryStatus.Open)
    .map((entry) => entry.key);
  const isAfterLimit = isLimit(error) || on?.isAfterLimit === true;
  return { sidePath: { next: to, isAfterLimit, owed } };
}

/** What a visit that succeeded leaves: its side path on to `next`, none past a launch or off it. */
export function sidePathAfter(
  state: ExecutionStateType,
  node: RuntimeNode,
  next: string | undefined,
): { readonly sidePath: SidePathRecord | null } {
  const on = sidePathOf(state, node);
  if (on === undefined || next === undefined || next === "") return { sidePath: null };
  return { sidePath: { ...on, next } };
}

/**
 * Whether `node`'s visit is an undo (#340): on a side path, of the newest open entry it undoes —
 * the one its visit closes —, one the side path owes. A visit of the same action anywhere else is a
 * step like any other.
 */
export function isOwedUndo(state: ExecutionStateType, node: RuntimeNode): boolean {
  const on = sidePathOf(state, node);
  if (on === undefined) return false;
  const undone = state.compensations
    .filter((entry) => entry.status === CompensationEntryStatus.Open)
    .sort((first, second) => first.sequence - second.sequence)
    .filter((entry) => entry.compensator === node.id)
    .at(-1);
  return undone !== undefined && on.owed.includes(undone.key);
}

/** The limits one execution is held to: its workflow's steps and its budgets. */
export interface ExecutionLimits {
  readonly maxSteps: number;
  readonly budgets: BudgetMeter;
}

/** Agents and routers are steps; starts, actions and finishes are not. */
export const isWorkingNode = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || node.kind === NodeKind.Router;

/**
 * Whether the budgets hold this visit back: all but a start, a finish, and an action on a side path
 * that took a limit (#656: that visit, and what it leads to step by step) or that undoes an entry
 * the side path owes — never an action by its name alone.
 */
const isBudgeted = (state: ExecutionStateType, node: RuntimeNode): boolean => {
  if (node.kind === NodeKind.Start || node.kind === NodeKind.Finish) return false;
  if (node.kind !== NodeKind.Action) return true;
  const isAfterLimit = sidePathOf(state, node)?.isAfterLimit === true;
  return !(isAfterLimit || isOwedUndo(state, node));
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
