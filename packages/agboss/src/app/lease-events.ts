import type { NodeEvent } from "../flow/observers/execution-event.js";
import type {
  ExecutionLeaseTakeoverEvent,
  StepHandedOverEvent,
} from "../flow/observers/lease-events.js";
import {
  ExecutionLeaseEventKind,
  HandOverReason,
  type ExecutionLeaseEventRecord,
  type HandOverSite,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../infrastructure/execution-lease-event.repository.js";
import { ApplicationStoppingError } from "./application-stopping.js";
import type { HandedOver } from "./handed-over.js";
import { ExecutionFencedError } from "./lease-lost.js";
import type { LeaseEventLog } from "./execution-leases.js";

/**
 * The lease log of an application instance (#501): each takeover and hand-over is masked like an
 * observer event, written as a row of the `ExecutionLeaseEventRepository` and then told to the
 * observers. Neither a store that fails (a warning, `lease-event.failed`) nor an observer that throws
 * (`observer.failed`) ever reaches the takeover or the hand-over it records. Loaded on the first
 * takeover or hand-over (`execution-leases.ts`).
 */

/** The event with only the fields it has: an absent optional one is left out, never `undefined`. */
function definedOf<T extends object>(event: T): T {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as T;
}

/** Writes `row`; a store that fails is a warning, never the caller's failure. */
async function saved(events: LeaseEventLog, row: ExecutionLeaseEventRecord): Promise<void> {
  try {
    await events.repository.save(row);
  } catch (error) {
    const text = `the lease log could not keep a ${row.kind} of execution ${row.executionId}: ${String(error)}`;
    events.log.warn("lease-event.failed", text, {
      executionId: row.executionId,
      tenantId: row.tenantId,
    });
  }
}

/** The row of a takeover. */
const takeoverRowOf = (event: ExecutionLeaseTakeoverEvent, at: Date): LeaseTakeoverRecord =>
  definedOf({
    kind: ExecutionLeaseEventKind.Takeover,
    occurredAt: at.toISOString(),
    tenantId: event.tenantId,
    rootExecutionId: event.rootExecutionId,
    executionId: event.leaseExecutionId,
    scopeKey: event.scopeKey,
    token: event.token,
    holderInstanceId: event.holderInstanceId,
    reason: event.reason,
    previousHolderInstanceId: event.previousHolderInstanceId,
    previousToken: event.previousToken,
    checkpointId: event.checkpointId,
  });

/** A takeover: its row first, then `onExecutionLeaseTakeover`; never throws. */
export async function recordTakeover(
  events: LeaseEventLog,
  event: ExecutionLeaseTakeoverEvent,
): Promise<void> {
  try {
    // the mask keeps an event's shape: every string masked
    const shown = (await events.mask(definedOf(event))) as ExecutionLeaseTakeoverEvent;
    await saved(events, takeoverRowOf(shown, events.clock.now()));
    await events.observer.onExecutionLeaseTakeover(shown);
  } catch (error) {
    const text = `the takeover of execution ${event.leaseExecutionId} could not be recorded: ${String(error)}`;
    events.log.warn("lease-event.failed", text, {
      executionId: event.leaseExecutionId,
      tenantId: event.tenantId,
    });
  }
}

/** The lease a handed-over step held: what its row names when no fenced write says otherwise. */
export interface HandedOverLease {
  readonly scopeKey: string;
  readonly holderInstanceId: string;
  /** Its token when the step stopped (the last one held, when it was yielded). */
  readonly token: number;
}

/** What a site saw of a hand-over: the step's event, the error, where it was found. */
export interface HandOverReport {
  readonly event: NodeEvent;
  readonly error: HandedOver;
  readonly site: HandOverSite;
}

/** Why the step was handed over, and the scope and tokens its event names. */
function causeOf(error: HandedOver, lease: HandedOverLease) {
  if (error instanceof ExecutionFencedError) {
    const { scopeKey, token, observedToken } = error;
    const observed = observedToken === undefined ? {} : { observedToken };
    return { reason: HandOverReason.Fenced, scopeKey, token, ...observed };
  }
  const reason =
    error instanceof ApplicationStoppingError
      ? HandOverReason.ApplicationStopping
      : HandOverReason.LeaseLost;
  return { reason, scopeKey: lease.scopeKey, token: lease.token };
}

/** The event of a hand-over: the step's own event (as every node event), why, where, the lease. */
export const handOverEventOf = (
  report: HandOverReport,
  lease: HandedOverLease,
): StepHandedOverEvent => ({
  ...report.event,
  ...causeOf(report.error, lease),
  site: report.site,
  holderInstanceId: lease.holderInstanceId,
});

/** The row of a hand-over. */
const handOverRowOf = (event: StepHandedOverEvent, at: Date): StepHandedOverRecord =>
  definedOf({
    kind: ExecutionLeaseEventKind.HandedOver,
    occurredAt: at.toISOString(),
    tenantId: event.tenantId,
    rootExecutionId: event.rootExecutionId,
    executionId: event.executionId,
    scopeKey: event.scopeKey,
    token: event.token,
    holderInstanceId: event.holderInstanceId,
    reason: event.reason,
    site: event.site,
    step: {
      nodeId: event.step.nodeId,
      visitNumber: event.step.visitNumber,
      idempotencyKey: event.step.idempotencyKey,
    },
    observedToken: event.observedToken,
  });

/** A hand-over: its row first, then `onStepHandedOver`; never throws. */
export async function recordHandOver(
  events: LeaseEventLog,
  report: HandOverReport,
  lease: HandedOverLease,
): Promise<void> {
  const event = handOverEventOf(report, lease);
  try {
    // the mask keeps an event's shape: every string masked
    const shown = (await events.mask(event)) as StepHandedOverEvent;
    await saved(events, handOverRowOf(shown, events.clock.now()));
    await events.observer.onStepHandedOver(shown);
  } catch (error) {
    const text = `the hand-over of execution ${event.executionId} could not be recorded: ${String(error)}`;
    events.log.warn("lease-event.failed", text, {
      executionId: event.executionId,
      tenantId: event.tenantId,
    });
  }
}
