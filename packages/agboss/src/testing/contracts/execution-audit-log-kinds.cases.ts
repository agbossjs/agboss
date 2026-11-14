import { expect } from "vitest";
import {
  ExecutionAuditEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  OutboundCallEventOutcome,
  type ExecutionAuditEventBase,
  type ExecutionAuditEventRecord,
  type ExecutionAuditLogRepository,
  type FencedEffectRecord,
  type OutboundCallEventRecord,
} from "../../infrastructure/execution-audit-log.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";

/**
 * The audit log's rows, every kind the core writes (#526 AC6, found by agbossjs/postgres#8): each
 * takeover reason, hand-over reason and site, fenced-effect and outbound-call outcome and status,
 * with every optional field and without — the #508 ones above all (`lease-closed` and
 * `superseded`, `closedLease`, `supersededBy`, `replayedFrom`). A store on a row schema of
 * before them rejects or loses them; it passes the cases above, and fails these.
 */

const NINE = "2026-01-05T09:00:00.000Z";

const base = (token: number): Omit<ExecutionAuditEventBase, "kind"> => ({
  occurredAt: NINE,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token,
  holderInstanceId: "instance-2",
});

const STEP = { nodeId: "charge-action", visitNumber: 2, idempotencyKey: "root-1:charge-action:2" };
const OTHER_STEP = { executionId: "root-0", nodeId: "charge-action", visitNumber: 1 };

/** Every takeover reason; the first with each optional field, the others with none. */
const TAKEOVERS: readonly ExecutionAuditEventRecord[] = Object.values(LeaseTakeoverReason).map(
  (reason, index) => ({
    ...base(index + 2),
    kind: ExecutionAuditEventKind.Takeover,
    reason,
    ...(index === 0
      ? { previousHolderInstanceId: "instance-1", previousToken: 1, checkpointId: "checkpoint-7" }
      : {}),
  }),
);

/** Every hand-over reason at every site, the odd ones with the token the system saw. */
const HAND_OVERS: readonly ExecutionAuditEventRecord[] = Object.values(HandOverReason).flatMap(
  (reason) =>
    Object.values(HandOverSite).map((site, index) => ({
      ...base(1),
      kind: ExecutionAuditEventKind.HandedOver,
      reason,
      site,
      step: STEP,
      ...(index % 2 === 1 ? { observedToken: 2 } : {}),
    })),
);

/** A fenced-effect row of `outcome`, with the fields that outcome carries. */
const effectRow = (outcome: FencedEffectEventOutcome): FencedEffectRecord => ({
  ...base(2),
  kind: ExecutionAuditEventKind.FencedEffect,
  name: "charge",
  outcome,
  step: STEP,
  ...(outcome === FencedEffectEventOutcome.Replayed
    ? { writtenToken: 1, replayedFrom: OTHER_STEP }
    : {}),
  ...(outcome === FencedEffectEventOutcome.Refused ? { observedToken: 3 } : {}),
});

const STATUS_OF: Readonly<Record<OutboundCallEventOutcome, OutboundCallStatus>> = {
  [OutboundCallEventOutcome.Recorded]: OutboundCallStatus.Pending,
  [OutboundCallEventOutcome.Sent]: OutboundCallStatus.Completed,
  [OutboundCallEventOutcome.Replayed]: OutboundCallStatus.Completed,
  [OutboundCallEventOutcome.Reconciled]: OutboundCallStatus.Completed,
  [OutboundCallEventOutcome.NotSent]: OutboundCallStatus.Pending,
  [OutboundCallEventOutcome.Unknown]: OutboundCallStatus.Pending,
  [OutboundCallEventOutcome.Failed]: OutboundCallStatus.Failed,
  [OutboundCallEventOutcome.Ambiguous]: OutboundCallStatus.Pending,
  [OutboundCallEventOutcome.AttemptSuperseded]: OutboundCallStatus.Pending,
  [OutboundCallEventOutcome.Joined]: OutboundCallStatus.Completed,
  [OutboundCallEventOutcome.LeaseClosed]: OutboundCallStatus.Completed,
  [OutboundCallEventOutcome.Cancelled]: OutboundCallStatus.Pending,
};

/** An outbound-call row of `outcome`, with the fields that outcome carries (#508). */
const callRow = (outcome: OutboundCallEventOutcome): OutboundCallEventRecord => ({
  ...base(2),
  kind: ExecutionAuditEventKind.OutboundCall,
  name: "charge",
  target: "payments",
  operation: "charge",
  status: STATUS_OF[outcome],
  attempt: 2,
  outcome,
  step: STEP,
  ...(outcome === OutboundCallEventOutcome.Replayed ? { replayedFrom: OTHER_STEP } : {}),
  ...(outcome === OutboundCallEventOutcome.AttemptSuperseded ? { supersededBy: 3 } : {}),
  ...(outcome === OutboundCallEventOutcome.LeaseClosed
    ? { closedLease: { rootExecutionId: "root-0", leaseExecutionId: "root-0", token: 4 } }
    : {}),
});

const EFFECTS = Object.values(FencedEffectEventOutcome).map(effectRow);
const CALLS = Object.values(OutboundCallEventOutcome).map(callRow);

/** Saves `rows` on `writer`, then reads the tree on `reader`: what came back. */
async function roundTrip(
  writer: ExecutionAuditLogRepository,
  reader: ExecutionAuditLogRepository,
  rows: readonly ExecutionAuditEventRecord[],
): Promise<readonly ExecutionAuditEventRecord[]> {
  for (const row of rows) await writer.save(row);
  return reader.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1");
}

const KIND_CASES: readonly ContractCase<ExecutionAuditLogRepository>[] = [
  {
    name: "#526 AC6: every row kind, reason, site, outcome and status the core writes is read back as it was, in the order saved",
    run: async ({ first, second }) => {
      const rows = [...TAKEOVERS, ...HAND_OVERS, ...EFFECTS, ...CALLS];

      expect(await roundTrip(first, second, rows)).toEqual(rows);
    },
  },
  {
    name: "#508: a lease-closed row keeps the lease it closed (closedLease)",
    run: async ({ first, second }) => {
      const row = callRow(OutboundCallEventOutcome.LeaseClosed);

      expect(await roundTrip(first, second, [row])).toEqual([row]);
    },
  },
  {
    name: "#508: a superseded row keeps the attempt that took the intent over (supersededBy)",
    run: async ({ first, second }) => {
      const row = callRow(OutboundCallEventOutcome.AttemptSuperseded);

      expect(await roundTrip(first, second, [row])).toEqual([row]);
    },
  },
  {
    name: "#508: a business key's replay keeps the step it replayed (replayedFrom), on a fenced-effect row and an outbound-call row",
    run: async ({ first, second }) => {
      const rows = [
        effectRow(FencedEffectEventOutcome.Replayed),
        callRow(OutboundCallEventOutcome.Replayed),
      ];

      expect(await roundTrip(first, second, rows)).toEqual(rows);
    },
  },
  {
    name: "#501: a refused fenced-effect row keeps the token it observed; a row without an optional field comes back without it — absent, never null",
    run: async ({ first, second }) => {
      const rows = [
        { ...effectRow(FencedEffectEventOutcome.Ran) },
        { ...effectRow(FencedEffectEventOutcome.Refused) },
        ...TAKEOVERS.slice(1, 2),
      ];

      const found = await roundTrip(first, second, rows);

      expect(found).toEqual(rows);
      for (const field of ["writtenToken", "replayedFrom", "observedToken"])
        expect(found[0] !== undefined && field in found[0], field).toBe(false);
      expect(found[2] !== undefined && "previousHolderInstanceId" in found[2]).toBe(false);
    },
  },
];

/** The cases of every row kind, as a group of the audit log contract. */
export const auditEventKindCases = (): ContractGroup<ExecutionAuditLogRepository> => ({
  title: "every row the core writes",
  cases: KIND_CASES,
});
