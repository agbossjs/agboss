/**
 * #825 AC5 — the lease log's outcomes of a call that leaves the system are named apart: an attempt
 * overtaken by a newer one is `AttemptSuperseded` (`attempt-superseded`), a lease an outbound call's
 * check closed is `LeaseClosed` (`lease-closed`) with the `closedLease` — and `OutboundCallLeaseState`
 * says `LeaseClosed` for the same close. A row written before (`superseded`, `lease-superseded`,
 * `supersededLease`) reads with this version's names, through `app.leaseEventsOf` too: the migration
 * of what is stored, every store at once.
 */
import { describe, expect } from "vitest";
import {
  currentLeaseEventOf,
  ExecutionLeaseEventKind,
  ExecutionLeaseEventRepository,
  OutboundCallEventOutcome,
  OutboundCallLeaseState,
  type ExecutionLeaseEventRecord,
} from "../../src/infrastructure/execution-lease-event.repository.js";
import { OutboundCallStatus } from "../../src/infrastructure/outbound-call.repository.js";
import { testWith } from "../../src/testing/index.js";
import { InMemoryChargesApplication } from "../app/fixtures/rotation/rotation.application.js";

const test = testWith(InMemoryChargesApplication);

const CALL = {
  kind: ExecutionLeaseEventKind.OutboundCall,
  occurredAt: "2026-11-06T10:00:00.000Z",
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 2,
  holderInstanceId: "instance-1",
  name: "charge",
  target: "payments",
  operation: "charge",
  status: OutboundCallStatus.Completed,
  attempt: 1,
  step: { nodeId: "charge-action", visitNumber: 1, idempotencyKey: "root-1:charge-action:1" },
} as const;

/** A row as a version before #825 wrote it: the outcome's old value, the lease under its old name. */
function written(outcome: string, extra: object = {}): ExecutionLeaseEventRecord {
  // as a store hands back what an earlier version wrote: JSON, never checked against this version
  const row: ExecutionLeaseEventRecord = JSON.parse(JSON.stringify({ ...CALL, outcome, ...extra }));
  return row;
}

const CLOSED = { rootExecutionId: "root-0", leaseExecutionId: "root-0", token: 1 };

describe("#825 AC5: the names", () => {
  test("the values: three meanings, three names", () => {
    expect(OutboundCallEventOutcome.AttemptSuperseded).toBe("attempt-superseded");
    expect(OutboundCallEventOutcome.LeaseClosed).toBe("lease-closed");
    expect(OutboundCallLeaseState.LeaseClosed).toBe("lease-closed");
    expect(Object.values(OutboundCallEventOutcome)).not.toContain("superseded");
    expect(Object.values(OutboundCallLeaseState)).toEqual(["live", "ended", "lease-closed"]);
  });

  test("a row written before reads with this version's names; a current one as it is", () => {
    expect(currentLeaseEventOf(written("superseded", { supersededBy: 3 }))).toEqual({
      ...CALL,
      outcome: OutboundCallEventOutcome.AttemptSuperseded,
      supersededBy: 3,
    });
    expect(currentLeaseEventOf(written("lease-superseded", { supersededLease: CLOSED }))).toEqual({
      ...CALL,
      outcome: OutboundCallEventOutcome.LeaseClosed,
      closedLease: CLOSED,
    });
    const current = written(OutboundCallEventOutcome.Sent);
    expect(currentLeaseEventOf(current)).toBe(current);
  });

  test("through app.leaseEventsOf: a row the store kept from before is read under the new names", async ({
    app,
  }) => {
    await app.ready();
    await app
      .resolve(ExecutionLeaseEventRepository)
      .save(written("lease-superseded", { supersededLease: CLOSED }));

    const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId: "root-1" });

    expect(rows).toEqual([
      { ...CALL, outcome: OutboundCallEventOutcome.LeaseClosed, closedLease: CLOSED },
    ]);
  });
});
