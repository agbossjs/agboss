/**
 * #657 — an error `send` throws is a failure only when the call says it is definite
 * (`isDefiniteFailure`); every other one — a 5xx after the gateway charged, a reset connection, the
 * SDK's own timeout — leaves the intent `Pending`, so the next call asks `reconcile` before anything
 * is sent again, as after a crash. On `FakeOutboundGateway` with a key retention: an answer dropped
 * after the charge, the key forgotten, the order paid again — one payment (AC1); today's rule (every
 * error a failure, resent) charges twice (AC2).
 */
import { describe, expect, it } from "vitest";
import {
  OutboundCallEventOutcome,
  OutboundCallInFlightError,
  OutboundCallOutcomeStatus,
  OutboundCallStatus,
} from "../../src/index.js";
import {
  FakeGatewayError,
  FakeGatewayErrorKind,
  FakeGatewayFault,
  FakeOutboundGateway,
} from "../../src/testing/gateway/fake-outbound-gateway.js";
import { hours } from "../../src/units/index.js";
import {
  gatewayCharge,
  outboundFrame,
  rejectionOf,
  type OutboundFrame,
} from "../helpers/outbound-frame.js";

/** The gateway keeps keys a day; its books (what `reconcile` reads by reference) forever. */
const gatewayOn = (frame: OutboundFrame) =>
  new FakeOutboundGateway({ clock: frame.clock, capabilities: { keyRetention: hours(24) } });

/** Whether the gateway's error says it processed nothing: its definite failure. */
const isUnavailable = (error: unknown): boolean =>
  error instanceof FakeGatewayError && error.kind === FakeGatewayErrorKind.Unavailable;

/** The intent of `order:42`, as the store keeps it. */
const intentOf = async (frame: OutboundFrame) => {
  const [found] = await frame.store.findAllByTenantIdAndStatus(
    "default",
    OutboundCallStatus.Pending,
  );
  return found;
};

describe("#657 AC1: an error of unknown outcome is reconciled, never resent blindly", () => {
  it("AC1: the answer dropped after the charge — left Pending; the key forgotten, the order paid again: Reconciled, one payment", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const first = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);

    const error = await rejectionOf(frame.send(first.key, gatewayCharge(gateway)));
    expect(error).toBeInstanceOf(FakeGatewayError);
    expect(await intentOf(frame)).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 1 });
    expect((await intentOf(frame))?.failure).toBeUndefined();
    await frame.leases.release(first.lease);
    await frame.clock.advance(hours(25));
    const second = await frame.keyIn("execution-2");
    const outcome = await frame.send(second.key, gatewayCharge(gateway));

    expect(outcome).toMatchObject({ status: OutboundCallOutcomeStatus.Reconciled, attempt: 1 });
    expect(gateway.payments).toHaveLength(1);
    expect(outcome.result).toEqual({ paymentId: gateway.payments[0]?.paymentId });
  });

  it("the step run again in the same execution reconciles it too: Reconciled, nothing sent again", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const { key } = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
    await rejectionOf(frame.send(key, gatewayCharge(gateway)));

    const again = await frame.send(key, gatewayCharge(gateway));

    expect(again.status).toBe(OutboundCallOutcomeStatus.Reconciled);
    expect(gateway.payments).toHaveLength(1);
  });

  it("a gateway that processed nothing, not marked definite: reconciled — notSent(), sent once more under the same key", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const { key } = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.FailBeforeProcessing);
    await rejectionOf(frame.send(key, gatewayCharge(gateway)));

    const again = await frame.send(key, gatewayCharge(gateway));

    expect(again).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
    expect(frame.reports.map((report) => report.outcome)).toEqual([
      OutboundCallEventOutcome.Recorded,
      OutboundCallEventOutcome.Ambiguous,
      OutboundCallEventOutcome.NotSent,
      OutboundCallEventOutcome.Sent,
    ]);
    expect(gateway.payments).toHaveLength(1);
  });

  it("logged as a warning by the error's code only, never its text; nothing stored of it", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const options = gatewayCharge(gatewayOn(frame), {
      send: () => Promise.reject(new Error("card 4242 4242 4242 4242 timed out")),
    });

    await rejectionOf(frame.send(key, options));

    const [entry] = frame.logger.entries;
    expect(entry).toMatchObject({ level: "warn", code: "outbound-call.outcome-unknown" });
    expect(entry?.message).toMatch(/attempt 1 threw an error of unknown outcome \(Error\)/u);
    expect(entry?.message).not.toMatch(/4242/u);
    expect(JSON.stringify(await intentOf(frame))).not.toMatch(/4242/u);
  });
});

describe("#657 AC2: the bite — every error taken for a failure, as before #657", () => {
  it("AC2: isDefiniteFailure true for the dropped answer: Failed, resent past the key's retention — two payments", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const asBefore = gatewayCharge(gateway, { isDefiniteFailure: () => true });
    const first = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
    await rejectionOf(frame.send(first.key, asBefore));
    await frame.leases.release(first.lease);
    await frame.clock.advance(hours(25));
    const second = await frame.keyIn("execution-2");

    const outcome = await frame.send(second.key, asBefore);

    expect(outcome).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
    expect(gateway.payments).toHaveLength(2);
  });
});

describe("#657: what counts as definite — only a true from isDefiniteFailure", () => {
  const CLASSIFIERS = [
    ["no predicate", undefined],
    ["false", () => false],
    ["a truthy non-boolean (JavaScript)", () => JSON.parse('"yes"') as boolean],
    [
      "a predicate that throws",
      () => {
        throw new Error("the classifier is broken");
      },
    ],
  ] as const;

  it.each(CLASSIFIERS)(
    "%s: unknown — Pending, the next call reconciles",
    async (_, isDefiniteFailure) => {
      const frame = outboundFrame();
      const gateway = gatewayOn(frame);
      const { key } = await frame.keyIn("execution-1");
      gateway.injectFault(FakeGatewayFault.FailBeforeProcessing);
      const options = gatewayCharge(
        gateway,
        isDefiniteFailure === undefined ? {} : { isDefiniteFailure },
      );

      await rejectionOf(frame.send(key, options));

      expect(await intentOf(frame)).toMatchObject({
        status: OutboundCallStatus.Pending,
        attempt: 1,
      });
    },
  );

  it("a predicate that throws is logged as a warning, and the error taken as unknown", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const options = gatewayCharge(gatewayOn(frame), {
      send: () => Promise.reject(new Error("timeout")),
      isDefiniteFailure: () => {
        throw new TypeError("broken");
      },
    });

    await rejectionOf(frame.send(key, options));

    expect(frame.logger.entries.map((entry) => entry.code)).toEqual([
      "outbound-call.classifier-threw",
      "outbound-call.outcome-unknown",
    ]);
    expect(frame.logger.entries[0]?.message).toBe(
      'isDefiniteFailure of outbound call "charge" (charge on gateway) threw (TypeError): the error is taken as of unknown outcome',
    );
  });

  it("true: Failed with the error, then sent again under the same key without reconcile", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const seen: unknown[] = [];
    let lookups = 0;
    const options = gatewayCharge(gateway, {
      isDefiniteFailure: (error) => {
        seen.push(error);
        return isUnavailable(error);
      },
      reconcile: () => {
        lookups += 1;
        throw new Error("never asked");
      },
    });
    const { key } = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.FailBeforeProcessing);

    const error = await rejectionOf(frame.send(key, options));
    expect(seen).toEqual([error]);
    expect(await frame.store.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Failed,
      failure: { name: "FakeGatewayError", code: "fake-gateway" },
    });
    const again = await frame.send(key, options);

    expect(again).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
    expect([lookups, gateway.payments.length]).toEqual([0, 1]);
  });
});

describe("#657: an intent left pending by an error, under a business key", () => {
  it("while the execution that sent it holds its lease, another execution is in flight — nothing sent; once it ended, reconciled", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const first = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
    await rejectionOf(frame.send(first.key, gatewayCharge(gateway)));
    const second = await frame.keyIn("execution-2");

    const refused = await rejectionOf(frame.send(second.key, gatewayCharge(gateway)));
    await frame.leases.release(first.lease);
    const after = await frame.send(second.key, gatewayCharge(gateway));

    expect(refused).toBeInstanceOf(OutboundCallInFlightError);
    expect(after.status).toBe(OutboundCallOutcomeStatus.Reconciled);
    expect(gateway.payments).toHaveLength(1);
  });

  it("two calls of this instance at once: the second joins the first and shares its error; the intent stays Pending", async () => {
    const frame = outboundFrame();
    const gateway = gatewayOn(frame);
    const { key } = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);

    const both = await Promise.all([
      rejectionOf(frame.send(key, gatewayCharge(gateway))),
      rejectionOf(frame.send(key, gatewayCharge(gateway))),
    ]);

    expect(both[0]).toBeInstanceOf(FakeGatewayError);
    expect(both[1]).toBe(both[0]);
    expect(await intentOf(frame)).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 1 });
    expect(gateway.payments).toHaveLength(1);
  });
});
