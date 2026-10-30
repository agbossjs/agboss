/**
 * #505 — every move of a call that leaves the system is told: an `OutboundCall` row of the lease
 * log (`app.leaseEventsOf`) and `onOutboundCall`, in order, never the request or the result —
 * recorded and sent, failed, replayed, reconciled (completed, not sent, unknown); a kept record
 * carries its tree's calls, masked (`ExecutionHistoryRecord.outboundCalls`).
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionHistoryRepository,
  ExecutionLeaseEventKind,
  OutboundCallEventOutcome,
  OutboundCallStatus,
  type ExecutionLeaseEventRecord,
} from "../../src/index.js";
import type { TestApp, TestLeases, VirtualClock } from "../../src/testing/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, settle } from "./fixtures/fence-takeover.js";
import {
  ChargeWorkflowStart,
  frozenRuns,
  heard,
  KeptOutboundCallApplication,
  letRunsGo,
  OutboundCallApplication,
  resetRuns,
  runs,
} from "./fixtures/outbound-call.workflow.js";
import {
  frozenCharges,
  gateway,
  letChargesGo,
  LookupMode,
  resetGateway,
} from "./fixtures/payment-gateway.js";

const test = testWith(OutboundCallApplication);
const two = testWith(OutboundCallApplication, { instances: 2 });
const kept = testWith(KeptOutboundCallApplication);

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(() => {
  letChargesGo();
  letRunsGo();
});

/** The outbound-call rows of the tree: outcome, the intent's state and attempt, the token. */
const movesOf = (rows: readonly ExecutionLeaseEventRecord[]) =>
  rows.flatMap((row) =>
    row.kind === ExecutionLeaseEventKind.OutboundCall
      ? [{ outcome: row.outcome, status: row.status, attempt: row.attempt, token: row.token }]
      : [],
  );

/** A frozen by `freeze`, its lease stalled; B's sweep recovers the tree under token 2. */
async function recovered(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
  freeze: () => Promise<void>,
): Promise<TestApp> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  execute(a, ChargeWorkflowStart, { text: "order-7" }).catch(() => undefined);
  await freeze();
  leases.stall(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await settle();
  await ends(1);
  return b;
}

describe("#505: the moves of a call, told", () => {
  test("a send: Recorded then Sent — the row and the event name the call, never its payload", async ({
    app,
  }) => {
    await execute(app, ChargeWorkflowStart, { text: "order-7 alice@example.com" });

    const rows = await app.leaseEventsOf(TREE);

    expect(movesOf(rows)).toEqual([
      {
        outcome: OutboundCallEventOutcome.Recorded,
        status: OutboundCallStatus.Pending,
        attempt: 1,
        token: 1,
      },
      {
        outcome: OutboundCallEventOutcome.Sent,
        status: OutboundCallStatus.Completed,
        attempt: 1,
        token: 1,
      },
    ]);
    expect(heard.events.map((event) => event.outcome)).toEqual([
      OutboundCallEventOutcome.Recorded,
      OutboundCallEventOutcome.Sent,
    ]);
    expect(heard.events[0]).toMatchObject({
      name: "charge",
      target: "payments",
      operation: "charge",
      scopeKey: "default:execution-1",
      step: { nodeId: "charge-order-action", visitNumber: 1 },
      holderInstanceId: expect.any(String) as unknown,
    });
    expect(JSON.stringify([rows, heard.events])).not.toMatch(/alice|ch-order|amountUsd/);
  });

  test("a provider error: Recorded then Failed", async ({ app }) => {
    gateway.failNext = 1;

    await execute(app, ChargeWorkflowStart, { text: "order-7" }).catch(() => undefined);

    expect(movesOf(await app.leaseEventsOf(TREE)).map((move) => move.outcome)).toEqual([
      OutboundCallEventOutcome.Recorded,
      OutboundCallEventOutcome.Failed,
    ]);
  });

  test("an observer that throws is a warning: the call and its rows are not touched", async ({
    app,
  }) => {
    heard.throws = true;

    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    expect(result.output).toEqual({ chargeId: "ch-order-7-1" });
    expect(movesOf(await app.leaseEventsOf(TREE))).toHaveLength(2);
  });

  two(
    "left pending, reconciled as completed: Recorded (token 1), then Reconciled (token 2)",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;

      const b = await recovered(apps, clock, leases, () => frozenCharges(1));

      expect(movesOf(await b.leaseEventsOf(TREE))).toEqual([
        {
          outcome: OutboundCallEventOutcome.Recorded,
          status: OutboundCallStatus.Pending,
          attempt: 1,
          token: 1,
        },
        {
          outcome: OutboundCallEventOutcome.Reconciled,
          status: OutboundCallStatus.Completed,
          attempt: 1,
          token: 2,
        },
      ]);
    },
  );

  two("never arrived: Recorded, NotSent (attempt 2), Sent", async ({ apps, clock, leases }) => {
    gateway.gates.before = 1;

    const b = await recovered(apps, clock, leases, () => frozenCharges(1));

    expect(movesOf(await b.leaseEventsOf(TREE))).toEqual([
      {
        outcome: OutboundCallEventOutcome.Recorded,
        status: OutboundCallStatus.Pending,
        attempt: 1,
        token: 1,
      },
      {
        outcome: OutboundCallEventOutcome.NotSent,
        status: OutboundCallStatus.Pending,
        attempt: 2,
        token: 2,
      },
      {
        outcome: OutboundCallEventOutcome.Sent,
        status: OutboundCallStatus.Completed,
        attempt: 2,
        token: 2,
      },
    ]);
  });

  two(
    "nobody can say: Recorded, then Unknown — the intent pending",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;
      gateway.lookup = LookupMode.Unknown;

      const b = await recovered(apps, clock, leases, () => frozenCharges(1));

      expect(movesOf(await b.leaseEventsOf(TREE)).map((move) => move.outcome)).toEqual([
        OutboundCallEventOutcome.Recorded,
        OutboundCallEventOutcome.Unknown,
      ]);
    },
  );

  two(
    "completed before the crash: Recorded, Sent, then Replayed on the new holder",
    async ({ apps, clock, leases }) => {
      runs.freezeAfter = 1;

      const b = await recovered(apps, clock, leases, () => frozenRuns(1));

      expect(movesOf(await b.leaseEventsOf(TREE))).toEqual([
        {
          outcome: OutboundCallEventOutcome.Recorded,
          status: OutboundCallStatus.Pending,
          attempt: 1,
          token: 1,
        },
        {
          outcome: OutboundCallEventOutcome.Sent,
          status: OutboundCallStatus.Completed,
          attempt: 1,
          token: 1,
        },
        {
          outcome: OutboundCallEventOutcome.Replayed,
          status: OutboundCallStatus.Completed,
          attempt: 1,
          token: 2,
        },
      ]);
    },
  );
});

describe("#505: a kept record carries its tree's calls", () => {
  kept(
    "ExecutionHistoryRecord.outboundCalls: every call of the tree, masked like the record",
    async ({ app }) => {
      gateway.receiptEmail = "bob@example.com";

      await execute(app, ChargeWorkflowStart, { text: "order-7 alice@example.com" });
      const record = await app
        .resolve(ExecutionHistoryRepository)
        .findByTenantIdAndExecutionId("default", "execution-1");

      expect(record?.outboundCalls).toEqual([
        expect.objectContaining({
          name: "charge",
          status: OutboundCallStatus.Completed,
          request: '{"orderId":"order-7","amountUsd":10,"email":"<email>"}',
          result: '{"chargeId":"ch-order-7-1 <email>"}',
        }),
      ]);
    },
  );
});
