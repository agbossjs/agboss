/**
 * #928 AC1 — a renewal is the one lease call that is never a hand-over by the bound, unless it is
 * `renewNow`'s (before an outbound send): the renewals of a step's checkpoints and of the
 * background end at 5 s as ordinary store errors, the holder goes on while its fence holds;
 * `renewNow` unanswered hands over at the trust's end and nothing is sent.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, StoreOutcomeSource } from "../../src/index.js";
import { testWith, type TestApp, type VirtualClock } from "../../src/testing/index.js";
import { reportHeldOperations } from "../../src/testing/faults/held-stores.js";
import { HoldPhase, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { OperationPhase } from "../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  ChargeWorkflowStart,
  book,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import {
  ChargeWorkflowStart as OutboundChargeStart,
  resetRuns,
} from "./fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";
import { causeOf, isGivingBack, settledFlag } from "./fixtures/store-bound-helpers.js";
import { StoreBoundLeasedApplication } from "./fixtures/store-bound-leased.application.js";
import { StoreBoundOutboundApplication } from "./fixtures/store-bound-outbound.application.js";

const one = testWith(StoreBoundLeasedApplication);
const outbound = testWith(StoreBoundOutboundApplication);

const operations: string[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetGateway();
  resetRuns();
  resetLogged();
  operations.length = 0;
  stop = reportHeldOperations({
    onOperation: (event) => {
      if (event.phase === OperationPhase.Invoke) operations.push(event.operation);
    },
  });
});

afterEach(() => {
  stop();
  processHoldPoints.releaseAll();
});

/** Until a hold waits at `point`. */
const heldAt = (point: StoreHoldPoint, what: string): Promise<void> =>
  until(() => processHoldPoints.held.some((held) => held.point === point.toString()), what);

describe("#928 AC1: the renewals", () => {
  outbound(
    "AC1: renewNow held for ever hands over at the trust's end; nothing is sent",
    async ({ app, clock }) => {
      await app.ready();
      // the intent is recorded first: the renewal asked for next is renewNow's, before the send
      processHoldPoints.arm({ point: StoreHoldPoint.OutboundSaveIfAbsent });
      const call = rejectionOf(execute(app, OutboundChargeStart, { text: "order-5" }));
      const isSettled = settledFlag(call);
      await heldAt(StoreHoldPoint.OutboundSaveIfAbsent, "the intent is held");
      processHoldPoints.arm({ point: StoreHoldPoint.LeaseRenew });
      const [intent] = processHoldPoints.held;
      if (intent === undefined) throw new Error("no hold");
      processHoldPoints.release(intent.holdId);
      await heldAt(StoreHoldPoint.LeaseRenew, "the renewal before the send is held");

      // the background renewals confirm meanwhile, yet the held one is bounded by its start's trust
      await passLive(clock, seconds(20));
      expect(isSettled()).toBe(false);
      await passLive(clock, seconds(10));
      await until(isSettled, "renewNow handed over");

      const error = await call;
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(causeOf(error)).toMatchObject({
        operation: "renew",
        source: StoreOutcomeSource.Framework,
      });
      expect(gateway.calls).toEqual([]);
      expect(operations.filter(isGivingBack)).toEqual([]);
    },
  );

  one(
    "AC1: a renewal held for ever inside a step ends at 5 s as an ordinary store error, never a hand-over; the step finishes under its token",
    async ({ app, clock }) => {
      await app.ready();
      // the first renewal asked is the step's checkpoint's
      processHoldPoints.arm({ point: StoreHoldPoint.LeaseRenew });
      const call = execute(app, ChargeWorkflowStart, { text: "order-7" });
      await heldAt(StoreHoldPoint.LeaseRenew, "the checkpoint's renewal is held");

      await passLive(clock, seconds(20));
      const outcome = await call;

      expect(outcome.output).toEqual({ chargeId: "charge-order-7-1" });
      const timeouts = logged.filter((entry) => entry.code === "store.call-timeout");
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.message).toContain("did not answer within 5000 ms");
      expect(timeouts[0]?.message).toContain("unleased call");
      expect(logged.map((entry) => entry.code)).not.toContain("execution.lease-abandoned");
      expect(operations.filter(isGivingBack)).toHaveLength(1);
    },
  );

  one(
    "AC1: one background renewal held for ever is survived — bounded at 5 s, confirmed by the next tick; the step finishes under its token",
    async ({ app, clock }) => {
      await app.ready();
      gates.before = 1;
      const call = execute(app, ChargeWorkflowStart, { text: "order-6" });
      await frozenRuns(1);
      processHoldPoints.arm({ point: StoreHoldPoint.LeaseRenew });
      await passLive(clock, seconds(36));
      letAllGo();

      const outcome = await call;

      expect(outcome.output).toEqual({ chargeId: "charge-order-6-1" });
      const timeouts = logged.filter((entry) => entry.code === "store.call-timeout");
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.message).toContain("did not answer within 5000 ms");
      expect(logged.map((entry) => entry.code)).not.toContain("execution.lease-abandoned");
    },
  );

  /** One order held before its effect while `arms` hit the renewals; its fate after 40 s, in order. */
  async function renewalsUnder(
    app: TestApp,
    clock: VirtualClock,
    orderId: string,
    arms: readonly Parameters<typeof processHoldPoints.arm>[0][],
  ): Promise<unknown> {
    gates.before = 1;
    const failure = rejectionOf(execute(app, ChargeWorkflowStart, { text: orderId }));
    await frozenRuns(1);
    for (const arm of arms) processHoldPoints.arm(arm);
    await passLive(clock, seconds(40));
    letAllGo();
    processHoldPoints.releaseAll();
    return failure;
  }

  const hung = { point: StoreHoldPoint.LeaseRenew } as const;
  const fast = {
    point: StoreHoldPoint.LeaseRenew,
    phase: HoldPhase.After,
    loseAnswer: true,
  } as const;

  one(
    "AC1: the tries at 7.5, 15 and 22.5 s (trust 29 s): two fast failures in a row are survived, the third confirms",
    async ({ app, clock }) => {
      await app.ready();
      const outcome = await renewalsUnder(app, clock, "order-9", [{ ...fast, times: 2 }]);
      expect(outcome).toBeUndefined();
    },
  );

  one(
    "AC1: one hung renewal (bounded at 5 s) plus one fast failure are survived; so are two hung ones, which end at 12.5 and 20 s",
    async ({ app, clock }) => {
      await app.ready();
      expect(await renewalsUnder(app, clock, "order-10", [hung, fast])).toBeUndefined();
      expect(await renewalsUnder(app, clock, "order-11", [{ ...hung, times: 2 }])).toBeUndefined();
    },
  );

  one(
    "AC1: three renewals in a row that fail, hung or fast, lose the lease: the fence stops the holder, the next take charges once",
    async ({ app, clock }) => {
      await app.ready();
      const outcome = await renewalsUnder(app, clock, "order-8", [{ ...hung, times: 3 }]);

      expect(outcome).toBeInstanceOf(ExecutionLeaseLostError);
      await passLive(clock, seconds(60));
      const [end] = await ends(1);
      expect(end?.output).toEqual({ chargeId: "charge-order-8-2" });
      expect(book.charges).toHaveLength(1);
      expect(logged.map((entry) => entry.code)).not.toContain("execution.lease-abandoned");
    },
  );
});
