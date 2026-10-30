import type { ExecutionLeaseTakeoverEvent } from "../flow/observers/lease-events.js";
import {
  ExecutionLeaseEventKind,
  type ExecutionLeaseEventRecord,
  type LeaseTakeoverRecord,
} from "../infrastructure/execution-lease-event.repository.js";
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
