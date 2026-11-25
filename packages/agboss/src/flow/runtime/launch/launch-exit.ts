import { pauseCalendarOf } from "../../../calendar/calendar-source.js";
import { workingTimeAfter, type CalendarSite } from "../../../calendar/calendar-call.js";
import type { Quorum } from "../../ast.js";
import type { Class } from "../../../components/injection.js";
import type { FrameSpec } from "../../context/frame.js";
import type { Clock } from "../../../infrastructure/clock.js";
import { isWorkingDuration } from "../../../units/index.js";
import type { FlowEdge } from "../../analyse/flow-graph.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { countsAsStep } from "../limits.js";
import type { NodeOutcome } from "../node-runner.js";
import type { ScopeRecords } from "../records.js";
import type { ExecutionStateType } from "../state.js";
import { visitNumberOf } from "../step-frame.js";
import { deadlineAtOf } from "./deadline.js";
import { isItemsOverflow } from "./items-limit.js";
import { dispatchOf } from "./dispatch.js";
import type { LaunchTicket } from "./records.js";
import { NO_VARIANT, type RuntimeLaunch } from "./runtime-launch.js";

/**
 * The launching step's way out (#273): the launch it takes — its own, or its variant's inside a
 * `.toOneOf([…])` — the edge its values are written on, and what comes next: its branches (one `Send`
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
  /** What a working-time quorum deadline is counted with (#1306). */
  readonly calendar: DeadlineSite;
}

/** Where a working-time deadline is asked of its calendar: the step's frame, the clock, the container. */
export interface DeadlineSite {
  readonly frame: FrameSpec;
  readonly clock: Clock;
  readonly container: { readonly get: <T>(token: Class<T>) => T };
  /** The run's stop: a calendar cut off by it is no calendar failure. */
  readonly interruption?: AbortSignal | undefined;
}

/**
 * A quorum's deadline from the moment of dispatch, in epoch milliseconds; none without one. A plain
 * duration is added to `now`; working time (`workDays(5)`) is asked of the quorum's `@WorkingCalendar`
 * (#1306), by the same call a pause's deadline is — a calendar that fails is a `PauseError.WorkingCalendar`.
 */
export async function quorumDeadlineAt(
  quorum: Quorum | undefined,
  now: Date,
  site: DeadlineSite,
): Promise<number | undefined> {
  const deadline = quorum?.deadline;
  if (quorum === undefined || deadline === undefined) return undefined;
  if (!isWorkingDuration(deadline)) return deadlineAtOf(now, deadline);
  const { frame, clock, container, interruption } = site;
  const calendarSite: CalendarSite = {
    calendar: pauseCalendarOf(quorum.calendar, (cls) => container.get(cls)),
    tenantId: frame.execution.tenant.tenantId,
    frame,
    clock,
    interruption,
  };
  return (await workingTimeAfter(calendarSite, now, deadline)).getTime();
}

/**
 * The ticket of the launch a visit takes: its branches, counted after the step's own visit. The
 * quorum's deadline is asked of its calendar only when branches will run (a list past `maxItems`
 * dispatches none); a calendar's failure is thrown as `PauseError.WorkingCalendar`.
 */
export async function launchTicketOf(
  visit: LaunchingVisit,
  launch: RuntimeLaunch,
): Promise<LaunchTicket> {
  const { node, state, outcome } = visit;
  const isStep = countsAsStep(state, node);
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
  if (isItemsOverflow(launch, ticket)) return ticket;
  const deadlineAt = await quorumDeadlineAt(launch.quorum, visit.now, visit.calendar);
  return deadlineAt === undefined ? ticket : { ...ticket, deadlineAt };
}
