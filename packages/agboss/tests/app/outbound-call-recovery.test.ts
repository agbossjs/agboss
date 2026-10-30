/**
 * #505 AC1–AC3 — a call that leaves the system, killed before the answer: the instance that sends
 * a charge freezes inside the provider's call and its lease stalls, the other instance's recovery
 * sweep takes the tree over and runs the step again. The intent recorded before the call is found
 * pending, so the charge is never sent blindly: `reconcile` asks the provider, and its verdict
 * decides — completed (the step continues with the provider's receipt), not sent (sent once more,
 * the same key, attempt 2) or unknown (the step fails, the intent stays pending for an operator).
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
  ChargeWorkflowStart,
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

const two = testWith(OutboundCallApplication, { instances: 2 });

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(() => {
  letChargesGo();
});

/** The key the charge of the first execution goes with. */
const KEY = "execution-1:charge-order-action:1:charge";

/**
 * A's charge frozen in the provider (before or after it processed the charge), A's lease stalled,
 * the clock past the lease and B's sweep: B recovers the tree under token 2. A's call, still waiting.
 */
async function killedBeforeTheAnswer(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
): Promise<{ readonly call: Promise<unknown>; readonly a: TestApp }> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
  call.catch(() => undefined);
  await frozenCharges(1);
  leases.stall(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await settle();
  return { call, a };
}

describe("#505 AC1: killed before the answer — reconciled, never sent again", () => {
  two(
    "AC1: killed before the answer → recovery reconciles, nothing re-sent, the step continues with the provider's result",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;

      const { call, a } = await killedBeforeTheAnswer(apps, clock, leases);
      const [end] = await ends(1);

      expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
      expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
      expect(runs.outcomes).toEqual([{ status: OutboundCallOutcomeStatus.Reconciled, attempt: 1 }]);
      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
      const [record] = await instance(apps, 1).outboundCallsOf({
        tenantId: "default",
        rootExecutionId: "execution-1",
      });
      expect(record).toMatchObject({ status: OutboundCallStatus.Completed, token: 2 });

      // A's answer arrives at last: its completion write is refused — a hand-over, nothing sent
      letChargesGo();
      leases.resume(a);
      await settle();
      expect(await rejectionOf(call)).toBeInstanceOf(ExecutionLeaseLostError);
      expect(gateway.calls).toHaveLength(1);
      expect(
        await instance(apps, 1).outboundCallsOf({
          tenantId: "default",
          rootExecutionId: "execution-1",
        }),
      ).toEqual([record]);
      expect(seen.errors).toEqual([]);
    },
  );
});

describe("#505 AC2: the provider never got it — sent once more", () => {
  two(
    "AC2: notSent → sent once more with the same idempotency key, attempt 2",
    async ({ apps, clock, leases }) => {
      gateway.gates.before = 1;

      await killedBeforeTheAnswer(apps, clock, leases);
      const [end] = await ends(1);

      expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
      expect(gateway.calls).toEqual([
        { idempotencyKey: KEY, attempt: 1 },
        { idempotencyKey: KEY, attempt: 2 },
      ]);
      expect(gateway.charges.size).toBe(1);
      expect(runs.outcomes).toEqual([{ status: OutboundCallOutcomeStatus.Sent, attempt: 2 }]);
      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
    },
  );
});

describe("#505 AC3: nobody can say — a defined error, the intent pending", () => {
  two(
    "AC3: unknown → OutboundCallUnreconciledError, intent pending, listed by pendingOutboundCalls",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;
      gateway.lookup = LookupMode.Unknown;

      await killedBeforeTheAnswer(apps, clock, leases);
      const [end] = await ends(1);

      // the side path of OutboundCallUnreconciledError took it: the error is the defined one
      expect(end?.finish).toBe("unreconciled-workflow-finish");
      const pending = await instance(apps, 1).pendingOutboundCalls({ tenantId: "default" });
      expect(pending).toEqual([
        expect.objectContaining({ idempotencyKey: KEY, status: OutboundCallStatus.Pending }),
      ]);
      expect(gateway.calls).toHaveLength(1);
      expect(runs.outcomes).toEqual([]);
    },
  );

  two(
    "a reconcile that throws is the same error — nothing sent again, the intent pending",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;
      gateway.lookup = LookupMode.Throws;

      await killedBeforeTheAnswer(apps, clock, leases);
      const [end] = await ends(1);

      expect(end?.finish).toBe("unreconciled-workflow-finish");
      expect(await instance(apps, 1).pendingOutboundCalls({ tenantId: "default" })).toHaveLength(1);
      expect(gateway.calls).toHaveLength(1);
    },
  );
});
