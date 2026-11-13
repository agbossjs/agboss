import { z } from "zod";
import type { ChildExecutionRecord } from "../flow/runtime/child-records.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "./execution-history.repository.js";
import {
  ExecutionAuditEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  OutboundCallEventOutcome,
  type ExecutionAuditEventRecord,
} from "./execution-audit-log.repository.js";
import { OutboundCallStatus } from "./outbound-call.repository.js";
import type { OutboundCallRecord } from "./outbound-call-record.js";
import {
  StoredCompensation,
  StoredCostReport,
  StoredError,
  StoredExecutionStep,
  StoredOrigin,
  StoredOutdatedValue,
  StoredScopeValue,
  StoredToolCall,
  storedEndedShape,
  StoredWorkflow,
} from "./stored-record-parts.js";
import { PauseAnswerRecordSchema, readStored, StoredComponent } from "./stored-step.js";

/**
 * A kept `ExecutionHistoryRecord` as a store keeps it as JSON (#401, #934), read whole: every
 * field the type has is checked — a field 0.1.0 already kept is required, one added after is
 * optional (`auditLog`, `outboundCalls`, a cost report's `unknownCalls`) —, the pauses of the
 * record and of its children's, at any depth, are read with the new names (a 0.1.0 entry too), and
 * a key the type does not know is dropped. What comes out is the type, asserted nowhere.
 */

const text = z.string();
const count = z.number();
/** What a record and a child share (`ExecutionRecord`, but its children and pauses). */
const executed = {
  path: z.array(text),
  scope: z.array(StoredScopeValue),
  outdatedValues: z.array(StoredOutdatedValue),
  lastError: StoredError.optional(),
  spend: StoredCostReport,
  pauses: z.array(PauseAnswerRecordSchema),
  compensations: z.array(StoredCompensation),
  toolCalls: z.array(StoredToolCall),
  steps: z.array(StoredExecutionStep),
  origin: StoredOrigin.optional(),
};

const Child: z.ZodType<ChildExecutionRecord> = z.lazy(() =>
  z.object({ ...storedEndedShape, pauses: executed.pauses, children: z.array(Child) }),
);

const eventBase = {
  occurredAt: text,
  tenantId: text,
  rootExecutionId: text,
  executionId: text,
  scopeKey: text,
  token: count,
  holderInstanceId: text,
};
const auditStep = z.object({ nodeId: text, visitNumber: count, idempotencyKey: text });
const origin = z.object({ executionId: text, nodeId: text, visitNumber: count });

/** A row of the audit log (#501): who took a lease over, what was handed over, the effects. */
const StoredAuditEvent: z.ZodType<ExecutionAuditEventRecord> = z.discriminatedUnion("kind", [
  z.object({
    ...eventBase,
    kind: z.literal(ExecutionAuditEventKind.Takeover),
    reason: z.enum(LeaseTakeoverReason),
    previousHolderInstanceId: text.optional(),
    previousToken: count.optional(),
    checkpointId: text.optional(),
  }),
  z.object({
    ...eventBase,
    kind: z.literal(ExecutionAuditEventKind.HandedOver),
    reason: z.enum(HandOverReason),
    site: z.enum(HandOverSite),
    step: auditStep,
    observedToken: count.optional(),
  }),
  z.object({
    ...eventBase,
    kind: z.literal(ExecutionAuditEventKind.FencedEffect),
    name: text,
    outcome: z.enum(FencedEffectEventOutcome),
    step: auditStep,
    writtenToken: count.optional(),
    replayedFrom: origin.optional(),
    observedToken: count.optional(),
  }),
  z.object({
    ...eventBase,
    kind: z.literal(ExecutionAuditEventKind.OutboundCall),
    name: text,
    target: text,
    operation: text,
    status: z.enum(OutboundCallStatus),
    attempt: count,
    outcome: z.enum(OutboundCallEventOutcome),
    step: auditStep,
    replayedFrom: origin.optional(),
    supersededBy: count.optional(),
    closedLease: z
      .object({ rootExecutionId: text, leaseExecutionId: text, token: count })
      .optional(),
  }),
]);

/** A call that left the system (#505), as the history keeps it. */
const StoredOutboundCall: z.ZodType<OutboundCallRecord> = z.object({
  tenantId: text,
  name: text,
  rootExecutionId: text,
  executionId: text,
  workflow: text,
  target: text,
  operation: text,
  idempotencyKey: text,
  request: text,
  attempt: count,
  attemptOwner: text,
  step: z.object({ nodeId: text, visitNumber: count }),
  status: z.enum(OutboundCallStatus),
  result: text.optional(),
  failure: z.object({ name: text, code: text, message: text }).optional(),
  token: count,
  leaseExecutionId: text,
  businessKey: text.optional(),
  fingerprint: text.optional(),
  businessKeyHash: text.optional(),
  recordedAt: text,
  endedAt: text.optional(),
  attemptStartedAt: text.optional(),
  firstAttemptStartedAt: text.optional(),
  readAt: text.optional(),
});

const StoredHistoryRecord: z.ZodType<ExecutionHistoryRecord> = z.object({
  ...executed,
  executionId: text,
  rootExecutionId: text,
  parentExecutionId: text.optional(),
  threadId: text,
  tenantId: text,
  application: z.object({ name: text, version: text, instanceId: text }),
  workflow: StoredWorkflow,
  status: z.enum(ExecutionHistoryStatus),
  startedAt: text,
  endedAt: text.optional(),
  start: StoredComponent,
  input: z.unknown(),
  finish: StoredComponent.optional(),
  output: z.unknown().optional(),
  contexts: z.object({
    tenant: z.record(text, z.unknown()),
    execution: z.record(text, z.unknown()),
  }),
  error: StoredError.optional(),
  auditLog: z.array(StoredAuditEvent).optional(),
  outboundCalls: z.array(StoredOutboundCall).optional(),
  children: z.array(Child),
});

/** A kept record from the parsed JSON a store holds: read whole, or unreadable (ids, field). */
export const executionHistoryRecordOfJson = (value: unknown): ExecutionHistoryRecord =>
  readStored(StoredHistoryRecord, value, "execution history record", ["executionId", "threadId"]);
