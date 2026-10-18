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
import { handedOverReason } from "../../app/handed-over.js";
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
import type { RuntimeGraph } from "./graph-model.js";
import { launchEdgeOf, launchFor, launchTicketOf, nextOfLaunch } from "./launch/launch-exit.js";
import { reportTruncation } from "./launch/launch-report.js";
import type { LaunchTicket } from "./launch/records.js";
import type { RuntimeLaunch } from "./launch/runtime-launch.js";

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
  /** The graph: what a launch dispatches (#273). */
  readonly graph: RuntimeGraph;
  readonly observer?: ObserverManager;
}

export async function daySpentBeforeRun(
  state: ExecutionStateType,
  deps: VisitDeps,
): Promise<number> {
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
export const unrecordedSpendOf = (error: unknown): readonly UsageRecord[] =>
  error instanceof PaidStepError || error instanceof LimitExceededError ? error.usage : [];

function visited(node: RuntimeNode, isStep: boolean): ExecutionStateUpdate {
  return { path: [node.id], visits: { [node.id]: 1 }, steps: isStep ? 1 : 0 };
}

/** A launch a visit took: its graph launch and the ticket of its branches (#273). */
interface Launched {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
}

/** A visit that succeeded: its bookkeeping, its way out and what its write did to the scope. */
interface Succeeded {
  readonly update: ExecutionStateUpdate;
  readonly write: VisitWrite;
  readonly launched?: Launched;
}

/** The launch a visit takes, with the ticket of its branches; none for a visit that launches nothing. */
function launchedBy(
  launch: RuntimeLaunch | undefined,
  node: RuntimeNode,
  outcome: NodeOutcome,
  site: {
    readonly state: ExecutionStateType;
    readonly deps: VisitDeps;
    readonly executionId: string;
  },
  write: VisitWrite,
): Launched | undefined {
  if (launch === undefined) return undefined;
  const { state, deps, executionId } = site;
  const scope = write.scope ?? state.scope;
  const visit = { graph: deps.graph, node, state, outcome, executionId, scope };
  return { launch, ticket: launchTicketOf(visit, launch) };
}

function succeeded(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: NodeOutcome,
  deps: VisitDeps,
  executionId: string,
): Succeeded {
  const launch = launchFor(node, outcome);
  const exit = launch === undefined ? exitOf(node, state, outcome) : launchEdgeOf(launch);
  const write = visitWrite(node, state, exit, outcome, deps.provenance);
  const launched = launchedBy(launch, node, outcome, { state, deps, executionId }, write);
  const next =
    launched === undefined ? (exit?.to ?? "") : nextOfLaunch(launched.launch, launched.ticket);
  const update = {
    ...visited(node, isWorkingNode(node)),
    ...write.update,
    next,
    ...(launched === undefined ? {} : { launch: launched.ticket }),
    usage: [...(outcome.usage ?? [])],
    approvals: [...(outcome.approvals ?? [])],
    ...(outcome.finish === undefined ? {} : { finish: node.id, output: outcome.finish.output }),
  };
  return { update, write, ...(launched === undefined ? {} : { launched }) };
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
  // a lost lease or an interruption is no failure of the step: another instance goes on (#265)
  const handedOver = handedOverReason(signal);
  if (handedOver !== undefined) throw handedOver;
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
      const executionId = frame.execution.executionId;
      const { update, write, launched } = succeeded(node, state, spent, deps, executionId);
      const outdatedSoFar = [...state.outdatedValues, ...write.outdated];
      const site = { observer: deps.observer, config, ...frame, outdatedSoFar };
      await reportOutdating(write.cascades, site);
      if (launched !== undefined) {
        const reportSite = { observer: deps.observer, config, frame };
        await reportTruncation(reportSite, launched.ticket, launched.launch.launch.maxItems);
      }
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
