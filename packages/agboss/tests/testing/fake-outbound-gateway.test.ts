/**
 * #508 — `FakeOutboundGateway`, the in-process gateway of the testing entry: each capability of
 * the Payment-gateways page on and off (G1 keys, G2 lookup, G3 retention, G4 first response, G5
 * conflict), each fault (answer-then-drop, fail-before-processing, slow), on the test's clock.
 */
import { describe, expect, it } from "vitest";
import {
  FakeGatewayErrorKind,
  FakeGatewayFault,
  FakeOutboundGateway,
  FULL_GATEWAY_CAPABILITIES,
  VirtualClock,
  type FakeGatewayCapabilities,
} from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";

const charge = { amount: 100, idempotencyKey: "order-7" };

const gatewayWith = (capabilities: Partial<FakeGatewayCapabilities> = {}) => {
  const clock = new VirtualClock();
  return { clock, gateway: new FakeOutboundGateway({ clock, capabilities }) };
};

describe("#508: the capabilities, on", () => {
  it("defaults to every capability, keys kept a day", () => {
    expect(gatewayWith().gateway.capabilities).toEqual(FULL_GATEWAY_CAPABILITIES);
    expect(FULL_GATEWAY_CAPABILITIES.keyRetention).toBe(hours(24));
  });

  it("G1 + G4: a repeat of a key is the first payment and its first response", async () => {
    const { gateway } = gatewayWith();

    const first = await gateway.charge(charge);
    const repeat = await gateway.charge(charge);

    expect(repeat).toEqual(first);
    expect(gateway.payments).toHaveLength(1);
  });

  it("G2: the payment is found by its key; an unknown key finds none", async () => {
    const { gateway } = gatewayWith();
    const made = await gateway.charge(charge);

    expect(await gateway.lookup("order-7")).toEqual(made);
    expect(await gateway.lookup("order-8")).toBeUndefined();
  });

  it("G3: a key is kept for its whole retention, then a repeat is a new payment", async () => {
    const { clock, gateway } = gatewayWith({ keyRetention: hours(1) });
    const first = await gateway.charge(charge);

    await clock.advance(hours(1));
    const within = await gateway.charge(charge);
    await clock.advance(seconds(1));
    const after = await gateway.charge(charge);

    expect(within.paymentId).toBe(first.paymentId);
    expect(after.paymentId).not.toBe(first.paymentId);
    expect(await gateway.lookup("order-7")).toEqual(after);
  });

  it("G5: the same key with another amount is refused, nothing made", async () => {
    const { gateway } = gatewayWith();
    await gateway.charge(charge);

    await expect(gateway.charge({ ...charge, amount: 200 })).rejects.toMatchObject({
      kind: FakeGatewayErrorKind.Conflict,
      code: "test.fake-gateway",
    });
    expect(gateway.payments).toHaveLength(1);
  });
});

describe("#508: the capabilities, off", () => {
  it("G1 off: every charge is a new payment, and no key finds one", async () => {
    const { gateway } = gatewayWith({ idempotencyKeys: false });

    await gateway.charge(charge);
    await gateway.charge(charge);

    expect(gateway.payments.map((payment) => payment.paymentId)).toEqual(["pay-1", "pay-2"]);
    expect(await gateway.lookup("order-7")).toBeUndefined();
  });

  it("G2 off: there is no lookup by key", async () => {
    const { gateway } = gatewayWith({ lookupByKey: false });
    await gateway.charge(charge);

    await expect(gateway.lookup("order-7")).rejects.toMatchObject({
      kind: FakeGatewayErrorKind.NoLookup,
    });
  });

  it("G4 off: a repeat is answered afresh — the same payment, another response", async () => {
    const { gateway } = gatewayWith({ firstResponseOnRepeat: false });

    const first = await gateway.charge(charge);
    const repeat = await gateway.charge(charge);
    const third = await gateway.charge(charge);

    expect(repeat).toEqual({ ...first, answer: 2 });
    expect(third.answer).toBe(3);
    expect(gateway.payments).toHaveLength(1);
  });

  it("G5 off: another amount under the same key gets the first payment, unchecked", async () => {
    const { gateway } = gatewayWith({ conflictOnMismatch: false });
    const first = await gateway.charge(charge);

    const other = await gateway.charge({ ...charge, amount: 200 });

    expect(other).toEqual(first);
  });
});

describe("#508: the faults", () => {
  it("answer-then-drop: the charge is made, the caller sees a timeout; a lookup finds it", async () => {
    const { gateway } = gatewayWith();
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);

    await expect(gateway.charge(charge)).rejects.toMatchObject({
      kind: FakeGatewayErrorKind.Timeout,
    });
    expect(gateway.payments).toHaveLength(1);
    expect(await gateway.lookup("order-7")).toMatchObject({ paymentId: "pay-1" });
  });

  it("fail-before-processing: nothing is made, the next charge goes through", async () => {
    const { gateway } = gatewayWith();
    gateway.injectFault(FakeGatewayFault.FailBeforeProcessing);

    await expect(gateway.charge(charge)).rejects.toMatchObject({
      kind: FakeGatewayErrorKind.Unavailable,
    });
    expect(gateway.payments).toEqual([]);
    await expect(gateway.charge(charge)).resolves.toMatchObject({ paymentId: "pay-1" });
  });

  it("slow: the answer comes only after its delay on the clock", async () => {
    const { clock, gateway } = gatewayWith();
    gateway.injectFault(FakeGatewayFault.Slow, { delay: seconds(5) });
    let isAnswered = false;

    const call = gateway.charge(charge).then((receipt) => {
      isAnswered = true;
      return receipt;
    });
    await clock.advance(seconds(4));
    const early = isAnswered;
    await clock.advance(seconds(1));

    expect(early).toBe(false);
    await expect(call).resolves.toMatchObject({ paymentId: "pay-1" });
  });

  it("a fault for several charges: each one meets it, then it is spent", async () => {
    const { gateway } = gatewayWith();
    gateway.injectFault(FakeGatewayFault.FailBeforeProcessing, { times: 2 });

    const outcomes = await Promise.allSettled([
      gateway.charge(charge),
      gateway.charge(charge),
      gateway.charge(charge),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
    ]);
  });
});
