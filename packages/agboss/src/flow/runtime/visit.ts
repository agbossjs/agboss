import { isGraphInterrupt } from "@langchain/langgraph";
import { errorRecordOf } from "../../core/error-record.js";
import type { UsageRecord } from "../../finops/usage.js";
import { PaidStepError } from "../../graph/errors.js";
import { LimitExceededError, type ResolvedLimits } from "../../graph/limits.js";
import type { FlowEdge } from "../analyse/flow-graph.js";
import { runInFrame } from "../context/frame.js";
import { errorHandlerOf, type RuntimeNode } from "./graph-model.js";
import { checkVisit, isWorkingNode } from "./limits.js";
import type { GraphNode, NodeOutcome, NodeRunner } from "./node-runner.js";
import { OutputInvalidError } from "./errors.js";
import { RouterDecisionError } from "./router-error.js";
import { isLeaseLost } from "../../app/lease-lost.js";
import { reportOutdating } from "./outdating-report.js";
import type { RuntimeProvenance } from "./provenance.js";
import {
  startedVersionOf,
  stepFrameOf,
  visitNumberOf,
  type WorkflowIdentity,
} from "./step-frame.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import { visitWrite, type VisitWrite } from "./visit-write.js";
import type { ObserverManager } from "../../core/observer-manager.js";

/**
 * A node's visit (#272 → Runtime): limits checked before an agent or a router runs, the node run,
 * its way out chosen — the router's route, the `switch` case of its value's class, its one next step,
 * or the end at a finish — and its value written to the scope on that edge, outdating what it makes
 * stale (#271: one observer event and trace entry per cascade). A failure goes to the
 * node's most specific `.onError` handler as a plain record in state (it holds after a resume);
 * without one the execution fails with the error as it is.
 */

/** The workflow's spend today, read once per execution (for `limits.perDay.cost`). */
export type SpentToday = () => Promise<number>;

export interface VisitDeps {
  readonly limits: ResolvedLimits;
  readonly spentToday: SpentToday;
  /** The workflow, for the step's `ExecutionContext` (#280). */
  readonly workflow: WorkflowIdentity;
  /** What values are built from (#271). */
  readonly provenance: RuntimeProvenance;
  readonly observer?: ObserverManager;
}

async function daySpentBeforeRun(state: ExecutionStateType, deps: VisitDeps): Promise<number> {
  if (state.daySpentBeforeRunUsd !== null) return state.daySpentBeforeRunUsd;
  return deps.limits.dayCostUsd === undefined ? 0 : deps.spentToday();
}

/** The edge a visit leaves by; `undefined` at a finish (the execution ends). */
function exitOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: NodeOutcome,
): FlowEdge | undefined {
  const { exits } = node;
  if (outcome.route !== undefined) {
    const route = exits.routes.get(outcome.route);
    if (route !== undefined) return route;
    const step = { nodeId: node.id, visitNumber: visitNumberOf(node, state) };
    const reason = `"${outcome.route}" is not one of its routes`;
    throw new RouterDecisionError(step, reason, outcome.usage ?? []);
  }
  if (exits.cases.size > 0) {
    const variant = outcome.value?.variant ?? "";
    const branch = exits.cases.get(variant);
    if (branch !== undefined) return branch;
    throw new OutputInvalidError(
      `${node.id} gave ${variant || "no class"}, which its switch has no caseOf(…) for`,
    );
  }
  return exits.next;
}

/** Spend a failure carries that the execution's state does not hold yet. */
const unrecordedSpendOf = (error: unknown): readonly UsageRecord[] =>
  error instanceof PaidStepError || error instanceof LimitExceededError ? error.usage : [];

function visited(node: RuntimeNode, isStep: boolean): ExecutionStateUpdate {
  return { path: [node.id], visits: { [node.id]: 1 }, steps: isStep ? 1 : 0 };
}

/** A visit that succeeded: its bookkeeping, its way out and what its write did to the scope. */
interface Succeeded {
  readonly update: ExecutionStateUpdate;
  readonly write: VisitWrite;
}

function succeeded(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: NodeOutcome,
  provenance: RuntimeProvenance,
): Succeeded {
  const exit = exitOf(node, state, outcome);
  const write = visitWrite(node, state, exit, outcome, provenance);
  const update = {
    ...visited(node, isWorkingNode(node)),
    ...write.update,
    next: exit?.to ?? "",
    usage: [...(outcome.usage ?? [])],
    approvals: [...(outcome.approvals ?? [])],
    ...(outcome.finish === undefined ? {} : { finish: node.id, output: outcome.finish.output }),
  };
  return { update, write };
}

/** A failure the node's `.onError` takes: kept as a record, the side path next; else rethrown. */
function caught(
  node: RuntimeNode,
  error: unknown,
  ranAsStep: boolean,
  services: readonly UsageRecord[],
  signal: AbortSignal | undefined,
): ExecutionStateUpdate {
  if (isGraphInterrupt(error)) throw error;
  // a lost lease is no failure of the step: the instance stops, the new holder goes on (#265)
  if (isLeaseLost(signal)) throw signal?.reason;
  const record = errorRecordOf(error);
  const handler = errorHandlerOf(node.exits, record);
  if (handler === undefined) throw error;
  return {
    ...visited(node, ranAsStep),
    lastError: record,
    next: handler.to,
    usage: [...unrecordedSpendOf(error), ...services],
  };
}

/**
 * Wraps a node's runner with the execution's bookkeeping; the runner runs in the step's frame (what
 * an injected `ExecutionContext` reads), closed when it returns (#280 S18).
 */
export function visitNode(node: RuntimeNode, runner: NodeRunner, deps: VisitDeps): GraphNode {
  return async (state, config) => {
    let ranAsStep = false;
    let daySpent: number | null = state.daySpentBeforeRunUsd;
    const kept = { startedVersion: startedVersionOf(state, deps.workflow) };
    // what the step's code paid services through `SpendRecorder` (#280 S43)
    const services: UsageRecord[] = [];
    const reportUsage = (record: UsageRecord): void => {
      services.push({ ...record, caller: `${node.kind}:${node.id}` });
    };
    try {
      if (isWorkingNode(node)) {
        daySpent = await daySpentBeforeRun(state, deps);
        checkVisit(state, node, deps.limits, daySpent);
        ranAsStep = true;
      }
      const frame = {
        ...stepFrameOf(node, state, config, deps.workflow),
        services: { reportUsage },
      };
      const outcome = await runInFrame(frame, () => runner(state, config));
      const spent = { ...outcome, usage: [...(outcome.usage ?? []), ...services] };
      const { update, write } = succeeded(node, state, spent, deps.provenance);
      const outdatedSoFar = [...state.outdatedValues, ...write.outdated];
      const site = { observer: deps.observer, config, ...frame, outdatedSoFar };
      await reportOutdating(write.cascades, site);
      return { ...update, daySpentBeforeRunUsd: daySpent, ...kept };
    } catch (error) {
      return {
        ...caught(node, error, ranAsStep, services, config?.signal),
        daySpentBeforeRunUsd: daySpent,
        ...kept,
      };
    }
  };
}
