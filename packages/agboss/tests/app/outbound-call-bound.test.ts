/**
 * #928 AC2 in-process — an outbound write that never answers is of unknown outcome: sent after
 * the send (`markCompleted`, `markFailed`) the holder hands over and the next holder reconciles,
 * never resends blind; before it (`saveIfAbsent`, `markPending`) the next holder reconciles the
 * intent and sends it once. The provider is charged once, whatever is held.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  OutboundCallSendStatus,
  OutboundCallStatus,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { HoldPhase, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import { OutboundCallBoundApplication } from "./fixtures/outbound-call-bound.application.js";
import { ChargeWorkflowStart, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import { gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

const two = testWith(OutboundCallBoundApplication, { instances: 2 });

const KEY = "execution-1:charge-order-action:1:charge";
const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
  resetLogged();
});

afterEach(() => {
  letChargesGo();
  processHoldPoints.releaseAll();
});

describe("#928 AC2: an outbound write held for ever", () => {
  two(
    "markCompleted held for ever: the next holder reconciles to completed; nothing resent; answer-unrecorded logged",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      processHoldPoints.arm({ point: StoreHoldPoint.OutboundMarkCompleted });
      const failure = rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-7" }));
      await until(() => processHoldPoints.held.length === 1, "markCompleted is held");
      expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);

      await passLive(clock, seconds(40));
      expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
      expect(logged.map((entry) => entry.code)).toContain("outbound-call.answer-unrecorded");
      expect(
        logged.find((entry) => entry.code === "outbound-call.answer-unrecorded")?.message,
      ).toMatch(/was sent, but its end was not recorded \(.*\.markCompleted, outcome unknown\)/u);
      const [pending] = await b.outboundCallsOf(TREE);
      expect(pending).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 1 });

      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
      expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Reconciled, attempt: 1 }]);
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
    },
  );

  two(
    "markFailed held for ever: the row stays Pending; reconciled before any resend",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      // the provider declines the first call: a definite failure, whose record never answers
      gateway.failNext = 1;
      processHoldPoints.arm({ point: StoreHoldPoint.OutboundMarkFailed });
      const failure = rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-8" }));
      await until(() => processHoldPoints.held.length === 1, "markFailed is held");

      await passLive(clock, seconds(40));
      expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
      expect(logged.map((entry) => entry.code)).toContain("outbound-call.answer-unrecorded");
      // the decline was never recorded: the row is Pending, nothing resent, nothing looked up yet
      const [pending] = await b.outboundCallsOf(TREE);
      expect(pending).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 1 });
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.lookups).toEqual([]);

      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      // reconciled first (the provider got nothing), then attempt 2, once
      expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
      expect(gateway.calls).toEqual([
        { idempotencyKey: KEY, attempt: 1 },
        { idempotencyKey: KEY, attempt: 2 },
      ]);
      expect(gateway.charges.size).toBe(1);
      expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Sent, attempt: 2 }]);
      expect(end?.output).toEqual({ chargeId: "ch-order-8-1" });
    },
  );

  for (const [phase, wasRecorded] of [
    [HoldPhase.After, true],
    [HoldPhase.Before, false],
  ] as const) {
    two(
      `saveIfAbsent ${phase === HoldPhase.After ? "committed then unanswered (HoldPhase.After never released): notSent → sent once" : "held before it commits (HoldPhase.Before): no row → recorded and sent once"}`,
      async ({ apps, clock }) => {
        const [a, b] = [instance(apps, 0), instance(apps, 1)];
        await a.ready();
        await b.ready();
        processHoldPoints.arm({ point: StoreHoldPoint.OutboundSaveIfAbsent, phase });
        const failure = rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-9" }));
        await until(() => processHoldPoints.held.length === 1, "saveIfAbsent is held");

        await passLive(clock, seconds(40));
        expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
        // nothing was sent: the send starts only once the intent is recorded
        expect(gateway.calls).toEqual([]);
        const rows = await b.outboundCallsOf(TREE);
        expect(rows.map((row) => [row.status, row.attempt])).toEqual(
          wasRecorded ? [[OutboundCallStatus.Pending, 1]] : [],
        );

        await passLive(clock, seconds(60));
        const [end] = await ends(1);

        expect(end?.output).toEqual({ chargeId: "ch-order-9-1" });
        expect(gateway.charges.size).toBe(1);
        if (wasRecorded) {
          // the intent was found pending: asked first, notSent, then attempt 2, once
          expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
          expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 2 }]);
          expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Sent, attempt: 2 }]);
        } else {
          expect(gateway.lookups).toEqual([]);
          expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
          expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Sent, attempt: 1 }]);
        }
      },
    );
  }

  two(
    "markPending held (before the send): Pending at attempt n+1 with an owner that never sent → reconcile → notSent → attempt n+2, once",
    async ({ apps, clock, leases }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      // attempt 1 frozen in the provider before it processed it, A's lease stalled: B takes the
      // tree over, asks the provider (nothing), claims attempt 2 — and the answer never comes
      gateway.gates.before = 1;
      const first = execute(a, ChargeWorkflowStart, { text: "order-6" });
      first.catch(() => undefined);
      await until(() => gateway.gates.frozen.length === 1, "attempt 1 is frozen in the provider");
      processHoldPoints.arm({ point: StoreHoldPoint.OutboundMarkPending, phase: HoldPhase.After });
      leases.freeze(a);
      // B's sweep takes the expired lease; B lives on (renews) while its claim is held
      for (let waited = 0; waited < 60 && processHoldPoints.held.length === 0; waited += 5) {
        await passLive(clock, seconds(5));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await until(
        () => processHoldPoints.held.length === 1,
        "B's claim of attempt 2 is held (committed, unanswered)",
      );

      await passLive(clock, seconds(40));
      // B's pass handed over; the intent says attempt 2 under an owner that never sent
      const [claimed] = await b.outboundCallsOf(TREE);
      expect(claimed).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 2 });
      expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);

      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      // attempt 2 was claimed and never sent: asked about, notSent, then attempt 3 — sent once
      expect(gateway.lookups).toEqual([
        { idempotencyKey: KEY, attempt: 1 },
        { idempotencyKey: KEY, attempt: 2 },
      ]);
      expect(gateway.calls).toEqual([
        { idempotencyKey: KEY, attempt: 1 },
        { idempotencyKey: KEY, attempt: 3 },
      ]);
      expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Sent, attempt: 3 }]);
      expect(gateway.charges.size).toBe(1);
      expect(end?.output).toEqual({ chargeId: "ch-order-6-1" });
    },
  );
});
