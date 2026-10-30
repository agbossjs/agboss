import type { NodeEvent } from "../flow/observers/execution-event.js";
import type { OutboundCallEvent } from "../flow/observers/lease-events.js";
import {
  ExecutionLeaseEventKind,
  type OutboundCallEventOutcome,
  type OutboundCallEventRecord,
} from "../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectOrigin } from "../infrastructure/fenced-effect.repository.js";
import type { OutboundCallStatus } from "../infrastructure/outbound-call.repository.js";
import type { LeaseEventLog } from "./execution-leases.js";
import { saved } from "./lease-events.js";

/**
 * The moves of a call that leaves the system (#505), told to the lease it runs under: each one
 * masked like an observer event, written as an `OutboundCall` row of the lease log, then told to
 * `onOutboundCall` — never its request or its result. Loaded with the lease log's recording.
 */

/** What the protocol saw of one move of a call: the step's event, the call, how it moved. */
export interface OutboundCallReport {
  readonly event: NodeEvent;
  readonly name: string;
  readonly target: string;
  readonly operation: string;
  readonly status: OutboundCallStatus;
  readonly attempt: number;
  readonly outcome: OutboundCallEventOutcome;
  readonly scopeKey: string;
  readonly token: number;
  readonly replayedFrom?: FencedEffectOrigin;
}

/** The row of a move: identities, the intent's state and tokens only. */
const outboundCallRowOf = (event: OutboundCallEvent, at: Date): OutboundCallEventRecord => ({
  kind: ExecutionLeaseEventKind.OutboundCall,
  occurredAt: at.toISOString(),
  tenantId: event.tenantId,
  rootExecutionId: event.rootExecutionId,
  executionId: event.executionId,
  scopeKey: event.scopeKey,
  token: event.token,
  holderInstanceId: event.holderInstanceId,
  name: event.name,
  target: event.target,
  operation: event.operation,
  status: event.status,
  attempt: event.attempt,
  outcome: event.outcome,
  ...(event.replayedFrom === undefined ? {} : { replayedFrom: event.replayedFrom }),
  step: {
    nodeId: event.step.nodeId,
    visitNumber: event.step.visitNumber,
    idempotencyKey: event.step.idempotencyKey,
  },
});

/** A move of a call: its row first, then `onOutboundCall`; never throws. */
export async function recordOutboundCall(
  events: LeaseEventLog,
  report: OutboundCallReport,
  holderInstanceId: string,
): Promise<void> {
  const { event: step, ...call } = report;
  const event: OutboundCallEvent = { ...step, ...call, holderInstanceId };
  try {
    // the mask keeps an event's shape: every string masked
    const shown = (await events.mask(event)) as OutboundCallEvent;
    await saved(events, outboundCallRowOf(shown, events.clock.now()));
    await events.observer.onOutboundCall(shown);
  } catch (error) {
    const text = `the outbound call "${report.name}" of execution ${event.executionId} could not be recorded: ${String(error)}`;
    events.log.warn("lease-event.failed", text, {
      executionId: event.executionId,
      tenantId: event.tenantId,
    });
  }
}
