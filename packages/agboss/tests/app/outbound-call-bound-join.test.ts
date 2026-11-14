/**
 * #928 AC2 in-process — the business-key join (#508): a joiner of a call whose answer could not be
 * recorded is not given the first call's hand-over: it makes the call itself, under its own lease,
 * where it reconciles the intent the first left pending.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  OutboundCallInFlightError,
  OutboundCallSendStatus,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  ledger,
  letLedgerGo,
  resetLedger,
  SendChargeStart,
} from "./fixtures/business-key.workflow.js";
import {
  down,
  OutboundCallBoundKeyedApplication,
} from "./fixtures/outbound-call-bound.application.js";
import { gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

const test = testWith(OutboundCallBoundKeyedApplication);

const ORDER = { orderId: "42", amountUsd: 10 };

beforeEach(() => {
  resetLedger();
  resetGateway();
  resetRecovery();
  resetLogged();
});

afterEach(() => {
  down.markFailed = 0;
  down.markCompleted = 0;
  letLedgerGo();
  letChargesGo();
  processHoldPoints.releaseAll();
});

describe("#928 AC2: the business-key joiner of a call whose answer was not recorded", () => {
  test("a business-key joiner of a call whose markCompleted timed out gets no hand-over error and reconciles under its own lease; isAnswered is set only after fencedEnd resolves", async ({
    app,
    clock,
  }) => {
    await app.ready();
    processHoldPoints.arm({ point: StoreHoldPoint.OutboundMarkCompleted });
    const first = rejectionOf(execute(app, SendChargeStart, ORDER, { threadId: "thread-first" }));
    await until(
      () => processHoldPoints.held.length === 1,
      "the first call's markCompleted is held",
    );
    // the second execution reaches its call and joins the first, which is still in flight
    const second = rejectionOf(execute(app, SendChargeStart, ORDER, { threadId: "thread-second" }));
    await settle();

    await passLive(clock, seconds(40));

    expect(await first).toBeInstanceOf(ExecutionLeaseLostError);
    // the first's hand-over is not shared: the joiner made the call itself — and the lease the first
    // abandoned is live in the store until it expires, so its intent is in flight, not yet its to reconcile
    const joinerError = await second;
    expect(joinerError).not.toBeInstanceOf(ExecutionLeaseLostError);
    expect(joinerError).toMatchObject({ cause: expect.any(OutboundCallInFlightError) });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.lookups).toEqual([]);

    // the lease expired: an execution of the same business key reconciles the intent, sends nothing
    await passLive(clock, seconds(60));
    const third = await execute(app, SendChargeStart, ORDER, { threadId: "thread-third" });

    expect(third.output).toEqual({ chargeId: "ch-42-1" });
    expect(gateway.calls).toHaveLength(1);
    expect(ledger.outbound).toContainEqual(OutboundCallSendStatus.Reconciled);
  });
});
