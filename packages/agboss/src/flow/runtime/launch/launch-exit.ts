import type { FlowEdge } from "../../analyse/flow-graph.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { isWorkingNode } from "../limits.js";
import type { NodeOutcome } from "../node-runner.js";
import type { ScopeRecords } from "../records.js";
import type { ExecutionStateType } from "../state.js";
import { visitNumberOf } from "../step-frame.js";
import { deadlineAtOf } from "./deadline.js";
import { dispatchOf } from "./dispatch.js";
import type { LaunchTicket } from "./records.js";
import { NO_VARIANT, type RuntimeLaunch } from "./runtime-launch.js";

/**
 * The launching step's way out (#273): the launch it takes — its own, or its variant's inside a
 * `.switch(…)` — the edge its values are written on, and what comes next: its branches (one `Send`
 * each, the conditional edge reads `LAUNCH_NEXT`), or straight its join when nothing was launched
 * (an empty list).
 */

/** `next` of a launching step: the conditional edge sends the launch's branches. */
export const LAUNCH_NEXT = "<launch>";

/** The launch a visit takes, when its node launches. */
export function launchFor(node: RuntimeNode, outcome: NodeOutcome): RuntimeLaunch | undefined {
  const { launches } = node.exits;
  if (launches.size === 0) return undefined;
  const variant = outcome.value?.variant;
  return variant === undefined ? launches.get(NO_VARIANT) : launches.get(variant);
}

/** The edge the launching step's values are written on (no branch's item). */
export const launchEdgeOf = (launch: RuntimeLaunch): FlowEdge => ({
  ...launch.join,
  writes: launch.writes,
});

/** Where the execution goes after the launching step. */
export const nextOfLaunch = (launch: RuntimeLaunch, ticket: LaunchTicket): string =>
  ticket.branches.length > 0 ? LAUNCH_NEXT : launch.joinNodeId;

/** What the launching step's visit dispatches from. */
export interface LaunchingVisit {
  readonly graph: RuntimeGraph;
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly outcome: NodeOutcome;
  readonly executionId: string;
  /** The scope after the step's own write. */
  readonly scope: ScopeRecords;
  /** The moment of dispatch on the application's `Clock` (a quorum's `deadlineAt`, #279). */
  readonly now: Date;
}

/** A quorum's deadline from the moment of dispatch; none without one. */
const deadlineOf = (launch: RuntimeLaunch, now: Date): number | undefined => {
  const deadline = launch.quorum?.deadline;
  return deadline === undefined ? undefined : deadlineAtOf(now, deadline);
};

/** The ticket of the launch a visit takes: its branches, counted after the step's own visit. */
export function launchTicketOf(visit: LaunchingVisit, launch: RuntimeLaunch): LaunchTicket {
  const { node, state, outcome } = visit;
  const isStep = isWorkingNode(node);
  const deadlineAt = deadlineOf(launch, visit.now);
  const ticket = dispatchOf({
    graph: visit.graph,
    launch,
    launcher: node,
    executionId: visit.executionId,
    visitNumber: visitNumberOf(node, state),
    scope: visit.scope,
    visits: { ...state.visits, [node.id]: visitNumberOf(node, state) },
    steps: state.steps + (isStep ? 1 : 0),
    ...(outcome.launch === undefined ? {} : { chosen: outcome.launch }),
  });
  return deadlineAt === undefined ? ticket : { ...ticket, deadlineAt };
}
