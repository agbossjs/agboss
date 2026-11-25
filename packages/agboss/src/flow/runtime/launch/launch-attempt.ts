import { PauseError } from "../../../core/error-families/pause-errors.js";
import type { NodeOutcome } from "../node-runner.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import type { VisitWrite } from "../visit-write.js";
import type { ComponentRecords } from "../workflow-keys.js";
import { itemsOverflowOf, joinErrorTaken } from "./items-limit.js";
import { launchTicketOf, type DeadlineSite } from "./launch-exit.js";
import type { LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * What a launching step's visit dispatches (#273): the ticket of its branches, or — when the launch
 * cannot start — the side path its join's `.onError(…)` takes at once, after the launching step's own
 * output is in the scope and with no branch dispatched and nothing spent past the producer:
 * a list past `.forEachItem(…, { maxItems })` is `LimitError.Items` (#1280); a quorum deadline in
 * working time whose `@WorkingCalendar` fails is `PauseError.WorkingCalendar` (#1306). Without such a
 * handler the error is thrown, like any step's.
 */

/** A launch a visit took: its graph launch and the ticket of its branches (#273). */
export interface Launched {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
}

/** What a launch came to: its branches, or the side path that stopped it. */
export interface LaunchAttempt {
  readonly launched?: Launched;
  readonly stoppedBy?: ExecutionStateUpdate;
  /** The error its join's `.onError(…)` took when it stopped: what the held undo's failure names. */
  readonly failure?: Error;
}

/** What a visit dispatches from. */
export interface LaunchSite {
  readonly state: ExecutionStateType;
  readonly deps: ComponentRecords & { readonly graph: RuntimeGraph };
  readonly executionId: string;
  readonly now: Date;
  readonly calendar: DeadlineSite;
}

/** The launch a visit takes, with the ticket of its branches; none for a visit that launches nothing. */
export async function launchAttemptOf(
  launch: RuntimeLaunch | undefined,
  node: RuntimeNode,
  outcome: NodeOutcome,
  site: LaunchSite,
  write: VisitWrite,
): Promise<LaunchAttempt | undefined> {
  if (launch === undefined) return undefined;
  const { state, deps, executionId, now, calendar } = site;
  const scope = write.scope ?? state.scope;
  const visit = { graph: deps.graph, node, state, outcome, executionId, scope, now, calendar };
  try {
    const launched = { launch, ticket: await launchTicketOf(visit, launch) };
    return itemsOverflowOf(launched, node, state, deps) ?? { launched };
  } catch (error) {
    if (!(error instanceof PauseError.WorkingCalendar)) throw error;
    const failure = new PauseError.WorkingCalendar({
      message: `${node.id}: the deadline of the quorum could not be counted: ${error.message}`,
      cause: error,
    });
    return { stoppedBy: joinErrorTaken({ launch, node, state, records: deps }, failure), failure };
  }
}
