import { expect } from "vitest";
import {
  ExecutionLeaseEventKind,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  OutboundCallEventOutcome,
  type ExecutionLeaseEventRecord,
  type OutboundCallEventRecord,
  type ExecutionLeaseEventRepository,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../../infrastructure/execution-lease-event.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { seconds } from "../../units/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./seam.js";

/** A takeover of `root-1` at `at` (ISO 8601). */
const takeover = (at: string, of: Partial<LeaseTakeoverRecord> = {}): LeaseTakeoverRecord => ({
  kind: ExecutionLeaseEventKind.Takeover,
  occurredAt: at,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 2,
  holderInstanceId: "instance-2",
  reason: LeaseTakeoverReason.Recovered,
  previousHolderInstanceId: "instance-1",
  previousToken: 1,
  checkpointId: "checkpoint-7",
  ...of,
});

/** A hand-over of `root-1`'s step at `at`. */
const handedOver = (at: string): StepHandedOverRecord => ({
  kind: ExecutionLeaseEventKind.HandedOver,
  occurredAt: at,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 1,
  holderInstanceId: "instance-1",
  reason: HandOverReason.Fenced,
  site: HandOverSite.Tool,
  step: { nodeId: "release-agent", visitNumber: 1, idempotencyKey: "root-1:release-agent:1:c1" },
  observedToken: 2,
});

/** A call of `root-1`'s step that left the system, reconciled at `at` (#505). */
const outboundCall = (at: string): OutboundCallEventRecord => ({
  kind: ExecutionLeaseEventKind.OutboundCall,
  occurredAt: at,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 2,
  holderInstanceId: "instance-2",
  name: "charge",
  target: "payments",
  operation: "charge",
  status: OutboundCallStatus.Completed,
  attempt: 1,
  outcome: OutboundCallEventOutcome.Reconciled,
  step: { nodeId: "charge-action", visitNumber: 1, idempotencyKey: "root-1:charge-action:1" },
});

/** Saves `rows` one after the other on `store`. */
async function saveAll(
  store: ExecutionLeaseEventRepository,
  rows: readonly ExecutionLeaseEventRecord[],
): Promise<void> {
  for (const row of rows) await store.save(row);
}

const NINE = "2026-01-05T09:00:00.000Z";
const NINE_ONE = "2026-01-05T09:01:00.000Z";

const LEASE_EVENT_CASES: readonly ContractCase<ExecutionLeaseEventRepository>[] = [
  {
    name: "a saved row is read back as it was, on the other instance",
    run: async ({ first, second }) => {
      await saveAll(first, [takeover(NINE), handedOver(NINE_ONE)]);

      const found = await second.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );

      expect(found).toEqual([takeover(NINE), handedOver(NINE_ONE)]);
    },
  },
  {
    name: "#505: an outbound call's row is read back as it was",
    run: async ({ first, second }) => {
      await saveAll(first, [outboundCall(NINE)]);

      const found = await second.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );

      expect(found).toEqual([outboundCall(NINE)]);
    },
  },
  {
    name: "rows come oldest first; rows of one moment in the order saved, whichever instance saved them",
    run: async ({ first, second }) => {
      await first.save(handedOver(NINE_ONE));
      await second.save(takeover(NINE, { token: 3 }));
      await first.save(takeover(NINE, { token: 4 }));

      const found = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );

      expect(found.map((row) => [row.occurredAt, row.token])).toEqual([
        [NINE, 3],
        [NINE, 4],
        [NINE_ONE, 1],
      ]);
    },
  },
  {
    name: "a tree's rows are its tenant's and its root's: another tenant or root finds none",
    run: async ({ first, second }) => {
      await saveAll(first, [
        takeover(NINE),
        takeover(NINE, { tenantId: "acme" }),
        takeover(NINE, { rootExecutionId: "root-2" }),
      ]);

      const other = await second.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "acme",
        "root-2",
      );
      const acme = await second.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "acme",
        "root-1",
      );

      expect(other).toEqual([]);
      expect(acme).toEqual([takeover(NINE, { tenantId: "acme" })]);
    },
  },
  {
    name: "the sweep removes the rows before its cutoff on the Clock, a row at the cutoff is kept",
    run: async ({ clock, first, second }) => {
      await first.save(takeover(clock.now().toISOString()));
      await clock.advance(seconds(60));
      const cutoff = clock.now();
      await first.save(takeover(cutoff.toISOString(), { token: 3 }));

      await second.deleteByOccurredAtBefore(cutoff);

      const found = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );
      expect(found.map((row) => row.token)).toEqual([3]);
    },
  },
];

/**
 * `ExecutionLeaseEventRepository` (#501): the append-only lease log — a saved row is read back as
 * it was on any instance, a tree's rows oldest first (one moment's in the order saved), scoped by
 * tenant and root; the sweep removes what happened before its cutoff on the `Clock`.
 */
export function executionLeaseEventContract(
  target: ContractTarget<ExecutionLeaseEventRepository>,
): void {
  registerContract("lease event contract", target, [{ cases: LEASE_EVENT_CASES }], pingOf);
}
