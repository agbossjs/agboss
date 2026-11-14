/**
 * #1017 AC1 in-process — an outbound write whose answer was reset after the store applied it is of
 * unknown outcome, as a timeout is: `markCompleted` (after the send) hands the holder over and the
 * next holder reconciles, never resends; a business-key joiner is not given the hand-over (#928's
 * `sharedOf` rule) and makes the call itself under its own lease.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  OutboundCallSendStatus,
  OutboundCallStatus,
  StoreOutcomeSource,
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
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { causeOf } from "./fixtures/store-bound-helpers.js";
import {
  ledger,
  letLedgerGo,
  resetLedger,
  SendChargeStart,
} from "./fixtures/business-key.workflow.js";
import {
  OutboundCallBoundApplication,
  OutboundCallBoundKeyedApplication,
} from "./fixtures/outbound-call-bound.application.js";
import { ChargeWorkflowStart, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import { gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

const two = testWith(OutboundCallBoundApplication, { instances: 2 });
const keyed = testWith(OutboundCallBoundKeyedApplication);

const KEY = "execution-1:charge-order-action:1:charge";
const TREE = { tenantId: "default", rootExecutionId: "execution-1" };
const ORDER = { orderId: "42", amountUsd: 10 };

/** The next `markCompleted` is applied by the store and its answer is reset. */
const resetAfterMarkCompleted = (): string =>
  processHoldPoints.arm({
    ...{ point: StoreHoldPoint.OutboundMarkCompleted, phase: HoldPhase.After },
    loseAnswer: true,
    asTransportError: true,
  });

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetLedger();
  resetRecovery();
  resetLogged();
});

afterEach(() => {
  letChargesGo();
  letLedgerGo();
  processHoldPoints.releaseAll();
});

describe("#1017 AC1: an outbound answer reset after the store applied it", () => {
  two(
    "markCompleted applied, answer reset: a hands over at once; the next holder reconciles to completed, nothing resent",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      resetAfterMarkCompleted();

      const error = await rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-7" }));

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(causeOf(error)).toMatchObject({ source: StoreOutcomeSource.Transport });
      expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
      expect(logged.map((entry) => entry.code)).toContain("outbound-call.answer-unrecorded");
      const [recorded] = await b.outboundCallsOf(TREE);
      expect(recorded).toMatchObject({ status: OutboundCallStatus.Completed, attempt: 1 });

      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
      expect(runs.outcomes).toEqual([{ status: OutboundCallSendStatus.Replayed, attempt: 1 }]);
      expect(gateway.calls).toHaveLength(1);
    },
  );

  keyed(
    "a business-key joiner of that call gets no hand-over error and makes the call itself",
    async ({ app, clock }) => {
      await app.ready();
      processHoldPoints.arm({ point: StoreHoldPoint.OutboundMarkCompleted });
      resetAfterMarkCompleted();
      const first = rejectionOf(execute(app, SendChargeStart, ORDER, { threadId: "thread-first" }));
      await until(() => processHoldPoints.held.length === 1, "the first markCompleted is held");
      const second = execute(app, SendChargeStart, ORDER, { threadId: "thread-second" });
      await settle();

      processHoldPoints.release(processHoldPoints.held[0]?.holdId ?? "none");
      await passLive(clock, seconds(1));

      expect(await first).toBeInstanceOf(ExecutionLeaseLostError);
      // the answer was recorded before it was reset: the joiner's own call replays it
      expect((await second).output).toEqual({ chargeId: "ch-42-1" });
      expect(ledger.outbound).toEqual([OutboundCallSendStatus.Replayed]);
      expect(gateway.calls).toHaveLength(1);
    },
  );
});
