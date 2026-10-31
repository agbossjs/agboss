/**
 * #505 AC4, AC5 — every call that left the system is a record an operator reads
 * (`app.outboundCallsOf`, per tree, with its state; masked like everything stored), a call sent and
 * a step run again after it (replayed, nothing sent), and the zombie: a stalled holder after a
 * takeover can neither record an intent nor send — before or after the new holder wrote.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  OutboundCallOutcomeStatus,
  OutboundCallStatus,
} from "../../src/index.js";
import type { TestApp, TestLeases, VirtualClock } from "../../src/testing/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { ends, resetRecovery, seen } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  ChargeAndNotifyWorkflowStart,
  ChargeWorkflowStart,
  frozenRuns,
  letRunsGo,
  OutboundCallApplication,
  resetRuns,
  runs,
} from "./fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";
import { passLive } from "../helpers/live-time.js";

const test = testWith(OutboundCallApplication);
const two = testWith(OutboundCallApplication, { instances: 2 });

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(() => {
  letRunsGo();
});

/** A frozen in its action, its lease stalled; B's sweep takes the tree over. A's call, waiting. */
async function stalledHolder(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
): Promise<{ readonly call: Promise<unknown>; readonly a: TestApp }> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
  call.catch(() => undefined);
  await frozenRuns(1);
  leases.stall(a);
  await clock.advance(seconds(31));
  // the new holder is live: its renewals reach the store in time (#534)
  await passLive(clock, seconds(31));
  await settle();
  return { call, a };
}

describe("#505 AC4: the calls that left the system, for an operator", () => {
  test("a call is recorded, sent once with its key and completed with its result (Sent, attempt 1)", async ({
    app,
  }) => {
    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    expect(result.output).toEqual({ chargeId: "ch-order-7-1" });
    expect(runs.outcomes).toEqual([{ status: OutboundCallOutcomeStatus.Sent, attempt: 1 }]);
    expect(gateway.calls).toEqual([
      { idempotencyKey: "execution-1:charge-order-action:1:charge", attempt: 1 },
    ]);
  });

  test("AC4: outboundCallsOf lists every call of the execution with its state", async ({ app }) => {
    await execute(app, ChargeAndNotifyWorkflowStart, { text: "order-8" });

    const calls = await app.outboundCallsOf(TREE);

    expect(calls).toEqual([
      expect.objectContaining({
        name: "charge",
        target: "payments",
        operation: "charge",
        status: OutboundCallStatus.Completed,
        result: '{"chargeId":"ch-order-8-1"}',
        attempt: 1,
        executionId: "execution-1",
        step: { nodeId: "charge-and-notify-action", visitNumber: 1 },
      }),
      expect.objectContaining({
        name: "receipt-mail",
        target: "mail",
        operation: "send-receipt",
        status: OutboundCallStatus.Completed,
        result: '{"messageId":"m-1"}',
        idempotencyKey: "execution-1:charge-and-notify-action:1:receipt-mail",
      }),
    ]);
    expect(await app.pendingOutboundCalls({ tenantId: "default" })).toEqual([]);
  });

  test("AC4: another tenant's tree, or another root, has no calls", async ({ app }) => {
    await execute(app, ChargeWorkflowStart, { text: "order-7" });

    expect(await app.outboundCallsOf({ ...TREE, tenantId: "acme" })).toEqual([]);
    expect(await app.outboundCallsOf({ ...TREE, rootExecutionId: "execution-2" })).toEqual([]);
  });

  test("the request is stored masked by the application's PII policies; send got it as it is", async ({
    app,
  }) => {
    await execute(app, ChargeWorkflowStart, { text: "order-7 alice@example.com" });

    const [call] = await app.outboundCallsOf(TREE);

    expect(call?.request).toBe('{"orderId":"order-7","amountUsd":10,"email":"<email>"}');
  });
});

describe("#505: a step run again after its call completed", () => {
  two(
    "a crash after the answer, before the checkpoint: the step run again replays the result, nothing sent",
    async ({ apps, clock, leases }) => {
      runs.freezeAfter = 1;

      await stalledHolder(apps, clock, leases);
      const [end] = await ends(1);

      expect(runs.outcomes).toEqual([
        { status: OutboundCallOutcomeStatus.Sent, attempt: 1 },
        { status: OutboundCallOutcomeStatus.Replayed, attempt: 1 },
      ]);
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.lookups).toEqual([]);
      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
    },
  );
});

describe("#505 AC5: a zombie can neither record nor send", () => {
  two(
    "AC5: a stalled holder after takeover cannot record an intent or send",
    async ({ apps, clock, leases }) => {
      runs.freezeBefore = 1;
      const { call, a } = await stalledHolder(apps, clock, leases);
      await ends(1);

      letRunsGo();
      leases.resume(a);
      await settle();

      expect(await rejectionOf(call)).toBeInstanceOf(ExecutionLeaseLostError);
      expect(gateway.calls).toEqual([
        { idempotencyKey: "execution-1:charge-order-action:1:charge", attempt: 1 },
      ]);
      expect(await instance(apps, 1).outboundCallsOf(TREE)).toEqual([
        expect.objectContaining({ status: OutboundCallStatus.Completed, token: 2 }),
      ]);
      expect(seen.errors).toEqual([]);
    },
  );

  two(
    "AC5: refused even when the zombie arrives before the new holder recorded anything",
    async ({ apps, clock, leases }) => {
      runs.freezeBefore = 2;
      const { call, a } = await stalledHolder(apps, clock, leases);
      await frozenRuns(2);
      const [zombie, newHolder] = runs.frozen.splice(0);

      zombie?.();
      leases.resume(a);
      await settle();
      const refused = await rejectionOf(call);
      const recordedByZombie = await instance(apps, 1).outboundCallsOf(TREE);
      newHolder?.();
      const [end] = await ends(1);

      expect(refused).toBeInstanceOf(ExecutionLeaseLostError);
      expect(recordedByZombie).toEqual([]);
      expect(gateway.calls).toHaveLength(1);
      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
    },
  );
});
