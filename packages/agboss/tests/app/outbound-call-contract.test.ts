/**
 * #795 — the outbound-call contract fails closed. Every `send` declares how far its `notSent()` is
 * trusted (`notSent: { trust: NotSentTrust.Lookup }` or `{ trust: NotSentTrust.KeyReplay,
 * keyRetention }`): leaving it out does not compile, and a JavaScript caller that leaves it out, or
 * gives a trust or a retention that is not one, is refused before anything is recorded or sent. An
 * attempt answered after a newer one took its intent over is an error, `OutboundCallSupersededError`,
 * never a normal outcome. Settings built by hand say whether a request is stored only masked.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  InMemoryOutboundCallRepository,
  InvalidFencedEffectNameError,
  InvalidNotSentTrustError,
  NotSentTrust,
  OutboundCallEventOutcome,
  OutboundCallOutcomeStatus,
  OutboundCallReconciliation,
  OutboundCallSettings,
  OutboundCallSupersededError,
  OutboundCallUnreconciledError,
  StepFailedError,
  type EffectKey,
  type OutboundCallFailure,
  type OutboundCallNotSent,
  type OutboundCallSendOptions,
} from "../../src/index.js";
import { stateOf } from "../../src/app/outbound-call-business.js";
import { untilReached } from "../helpers/reached.js";
import {
  FakeGatewayFault,
  FakeOutboundGateway,
} from "../../src/testing/gateway/fake-outbound-gateway.js";
import { hours, minutes, type Milliseconds } from "../../src/units/index.js";
import {
  gatewayCharge,
  outboundFrame,
  rejectionOf,
  type GatewayChargeRequest,
  type GatewayPaymentReceipt,
  type OutboundFrame,
} from "../helpers/outbound-frame.js";

type ChargeOptions = OutboundCallSendOptions<GatewayChargeRequest, GatewayPaymentReceipt>;

/** A gateway with no lookup, keeping keys a day: a replay of the key is how it tells an outcome. */
const replayOnly = (frame: OutboundFrame) =>
  new FakeOutboundGateway({
    clock: frame.clock,
    capabilities: { keyRetention: hours(24), lookupByKey: false },
  });

/** A charge left pending, its answer dropped after the gateway charged, and the clock `age` on. */
async function pendingFor(frame: OutboundFrame, gateway: FakeOutboundGateway, age: Milliseconds) {
  const { key } = await frame.keyIn("execution-1");
  gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
  await rejectionOf(frame.send(key, gatewayCharge(gateway)));
  await frame.clock.advance(age);
  return key;
}

describe("#795 AC1: the notSent trust is required", () => {
  it("leaving notSent out, or a KeyReplay without its keyRetention, does not compile", () => {
    const gateway = new FakeOutboundGateway({ clock: outboundFrame().clock });
    const { notSent: _, ...withoutTrust } = gatewayCharge(gateway);

    // @ts-expect-error — no notSent: the author must say how far a notSent() is trusted
    const missing: ChargeOptions = withoutTrust;
    // @ts-expect-error — a key's replay is trusted only within the other system's retention
    const noRetention: OutboundCallNotSent = { trust: NotSentTrust.KeyReplay };
    // @ts-expect-error — a lookup has no retention to declare
    const lookupRetention: OutboundCallNotSent = { trust: NotSentTrust.Lookup, keyRetention: 1 };

    expect([missing, noRetention, lookupRetention]).toHaveLength(3);
    expectTypeOf<ChargeOptions["notSent"]>().toEqualTypeOf<OutboundCallNotSent>();
  });

  const IS_TRUSTED = "say how far a notSent() of reconcile is trusted";
  const NOT_A_DURATION = "not a positive, finite duration";
  const { KeyReplay, Lookup } = NotSentTrust;
  it.each([
    ["no notSent", undefined, `notSent is undefined, not a { trust }: ${IS_TRUSTED}`],
    ["a notSent of null", null, `notSent is null, not a { trust }: ${IS_TRUSTED}`],
    [
      "a notSent that is not an object",
      "lookup",
      `notSent is lookup, not a { trust }: ${IS_TRUSTED}`,
    ],
    [
      "an unknown trust",
      { trust: "always" },
      "notSent.trust is always, neither NotSentTrust.Lookup nor NotSentTrust.KeyReplay",
    ],
    [
      "a trust of a null-prototype object (its text cannot be made)",
      { trust: Object.create(null) as unknown },
      "notSent.trust is an object, neither NotSentTrust.Lookup nor NotSentTrust.KeyReplay",
    ],
    [
      "a KeyReplay with an object keyRetention",
      { trust: KeyReplay, keyRetention: Object.create(null) as unknown },
      `a KeyReplay's keyRetention is an object, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay without keyRetention",
      { trust: KeyReplay },
      `a KeyReplay's keyRetention is undefined, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay with a text keyRetention",
      { trust: KeyReplay, keyRetention: "86400000" },
      `a KeyReplay's keyRetention is 86400000, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay with a zero keyRetention",
      { trust: KeyReplay, keyRetention: 0 },
      `a KeyReplay's keyRetention is 0, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay with a negative keyRetention",
      { trust: KeyReplay, keyRetention: -1 },
      `a KeyReplay's keyRetention is -1, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay with keyRetention NaN",
      { trust: KeyReplay, keyRetention: Number.NaN },
      `a KeyReplay's keyRetention is NaN, ${NOT_A_DURATION}`,
    ],
    [
      "a KeyReplay with an infinite keyRetention",
      { trust: KeyReplay, keyRetention: Number.POSITIVE_INFINITY },
      `a KeyReplay's keyRetention is Infinity, ${NOT_A_DURATION}`,
    ],
    [
      "a Lookup with a keyRetention",
      { trust: Lookup, keyRetention: hours(24) },
      "a Lookup has no keyRetention: the record it reads does not expire",
    ],
  ])(
    "a JavaScript caller with %s is refused: nothing recorded, nothing sent",
    async (_, notSent, problem) => {
      const frame = outboundFrame();
      const gateway = new FakeOutboundGateway({ clock: frame.clock });
      const { key } = await frame.keyIn("execution-1");
      // a JavaScript caller's options: anything at all where the trust goes
      const options: ChargeOptions = { ...gatewayCharge(gateway), notSent: notSent as never };

      const refused = await rejectionOf(frame.send(key, options));

      expect(refused).toBeInstanceOf(InvalidNotSentTrustError);
      expect(refused).toMatchObject({
        code: "outbound-call.invalid-not-sent-trust",
        name: "InvalidNotSentTrustError",
        call: "charge",
        problem,
        details: { call: "charge" },
        message: `outbound call "charge" was refused: ${problem} — notSent: { trust: NotSentTrust.Lookup } or { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) }; nothing was recorded or sent`,
      });
      expect(gateway.payments).toEqual([]);
      expect(await frame.store.findByKey(key)).toBeUndefined();
      expect(frame.reports).toEqual([]);
    },
  );

  it("a KeyReplay with the smallest positive keyRetention is one: sent", async () => {
    const frame = outboundFrame();
    const gateway = new FakeOutboundGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");
    const notSent = { trust: KeyReplay, keyRetention: 1 as Milliseconds } as const;

    expect(await frame.send(key, gatewayCharge(gateway, { notSent }))).toMatchObject({
      status: OutboundCallOutcomeStatus.Sent,
    });
  });

  it("Lookup: the lookup is authoritative — a notSent() days later is sent again under the key", async () => {
    const frame = outboundFrame();
    const gateway = new FakeOutboundGateway({ clock: frame.clock });
    const key = await pendingFor(frame, gateway, hours(72));
    const notSent = () => OutboundCallReconciliation.notSent();

    const outcome = await frame.send(key, gatewayCharge(gateway, { reconcile: notSent }));

    expect(outcome).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
  });

  it("KeyReplay: the same notSent() past the key's retention is refused — one payment, the bite of a fail-open default", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, hours(25));
    const replay = gatewayCharge(gateway, {
      reconcile: () => OutboundCallReconciliation.notSent(),
      notSent: { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) },
    });

    const refused = await rejectionOf(frame.send(key, replay));

    expect(refused).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(gateway.payments).toHaveLength(1);
  });

  it("KeyReplay inside the retention: sent again, the gateway replays its key (one payment)", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, minutes(10));
    const replay = gatewayCharge(gateway, {
      reconcile: () => OutboundCallReconciliation.notSent(),
      notSent: { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) },
    });

    expect(await frame.send(key, replay)).toMatchObject({ attempt: 2 });
    expect(gateway.payments).toHaveLength(1);
  });
});

describe("#795 AC3: OutboundCallSupersededError", () => {
  it("is a StepFailedError with a literal code; Superseded is no outcome status", () => {
    expectTypeOf(OutboundCallSupersededError.code).toEqualTypeOf<"outbound-call.superseded">();
    expect(OutboundCallSupersededError.code).toBe("outbound-call.superseded");
    expect(Object.values(OutboundCallOutcomeStatus)).not.toContain("superseded");
    const error = new OutboundCallSupersededError({
      name: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "k-1",
      attempt: 1,
      supersededBy: 2,
    });

    expect(error).toBeInstanceOf(StepFailedError);
    expect(error.name).toBe("OutboundCallSupersededError");
    expect(error.usage).toEqual([]);
    expect(error).toMatchObject({
      code: "outbound-call.superseded",
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "k-1",
      attempt: 1,
      supersededBy: 2,
    });
    expect(error.message).toBe(
      'outbound call "charge" (charge on payments, key k-1) attempt 1 was answered after attempt 2 took its intent over: both reached payments — its answer is not stored; check payments before going on',
    );
    expect(error.details).toMatchObject({
      call: "charge",
      target: "payments",
      operation: "charge",
      attempt: 1,
      supersededBy: 2,
    });
    expect(error.component).toMatchObject({ name: "charge" });
  });

  it("the newer attempt unknown: supersededBy is undefined, never a guess", () => {
    const error = new OutboundCallSupersededError({
      name: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "k-1",
      attempt: 1,
      supersededBy: undefined,
    });

    expect(error.supersededBy).toBeUndefined();
    expect(error.message).toContain("after a newer attempt (which one is unknown)");
    expect(error.details).not.toHaveProperty("supersededBy");
  });
});

describe("#795 AC4: settings built by hand fail closed", () => {
  it("requiresMask is required in the options; none given at all is masked", () => {
    // @ts-expect-error — whether a request is stored only masked is never a silent default
    const unsaid = new OutboundCallSettings({});

    expect(unsaid).toBeInstanceOf(OutboundCallSettings);
    expect(new OutboundCallSettings().requiresMask).toBe(true); // none given: masked
    expect(new OutboundCallSettings({ requiresMask: false }).requiresMask).toBe(false);
  });

  it.each([
    ["no options at all", undefined],
    ["no requiresMask", {}],
    ["a requiresMask that is not a boolean", { requiresMask: "no" }],
  ])("a JavaScript caller with %s requires the mask", (_, options) => {
    // a JavaScript caller's options: anything at all, or none
    expect(new OutboundCallSettings(options as never).requiresMask).toBe(true);
  });
});

/** A rival that takes the intent over (attempt + 1) right before this attempt's end is written. */
class TakenOverOutboundCallRepository extends InMemoryOutboundCallRepository {
  /** Whether a read after the takeover fails (the report's read of the newer attempt). */
  static isUnreadable = false;
  #isTakenOver = false;

  override async markCompleted(key: EffectKey, owner: string, result: string) {
    await this.#takeOver(key);
    return super.markCompleted(key, owner, result);
  }

  override async markFailed(key: EffectKey, owner: string, failure: OutboundCallFailure) {
    await this.#takeOver(key);
    return super.markFailed(key, owner, failure);
  }

  override findByKey(key: EffectKey) {
    if (this.#isTakenOver && TakenOverOutboundCallRepository.isUnreadable)
      return Promise.reject(new InvalidFencedEffectNameError(0));
    return super.findByKey(key);
  }

  async #takeOver(key: EffectKey): Promise<void> {
    const found = await super.findByKey(key);
    if (found === undefined) return;
    const claim = { attempt: found.attempt + 1, attemptOwner: "rival" };
    await this.markPending(key, stateOf(found), claim);
    this.#isTakenOver = true;
  }
}

describe("#795 review: a superseded attempt fails every caller, whatever it answered", () => {
  it("a definite failure answered after a newer attempt took over: OutboundCallSupersededError, the decline its cause", async () => {
    TakenOverOutboundCallRepository.isUnreadable = false;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakeOutboundGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");
    const declined = new Error("card declined");
    const options = gatewayCharge(gateway, {
      send: () => Promise.reject(declined),
      isDefiniteFailure: () => true,
    });

    const failed = await rejectionOf(frame.send(key, options));

    expect(failed).toBeInstanceOf(OutboundCallSupersededError);
    expect(failed).toMatchObject({ attempt: 1, supersededBy: 2, cause: declined });
    expect(frame.logger.entries.map((entry) => [entry.code, entry.message])).toContainEqual([
      "outbound-call.superseded",
      'outbound call "charge" (charge on gateway) attempt 1 was answered after attempt 2 took its intent over: both reached gateway — check it there',
    ]);
    expect(frame.reports.at(-1)?.outcome).toBe(OutboundCallEventOutcome.Superseded);
  });

  it("a call joined to a superseded one shares its error: nothing sent again, one charge", async () => {
    TakenOverOutboundCallRepository.isUnreadable = false;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakeOutboundGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");
    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const options = gatewayCharge(gateway, {
      send: async (call) => {
        await answered;
        const receipt = await gateway.charge({ amount: 10, idempotencyKey: call.idempotencyKey });
        return { paymentId: receipt.paymentId };
      },
    });

    const first = rejectionOf(frame.send(key, options));
    await untilReached(() => frame.reports.length > 0, "the first call never recorded its intent");
    const joined = rejectionOf(frame.send(key, options));
    answer();

    expect(await first).toBeInstanceOf(OutboundCallSupersededError);
    expect(await joined).toBeInstanceOf(OutboundCallSupersededError);
    expect(gateway.payments).toHaveLength(1);
  });

  it("the report's read of the newer attempt fails: named on the log by its code, the error thrown all the same", async () => {
    TakenOverOutboundCallRepository.isUnreadable = true;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakeOutboundGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");

    const failed = await rejectionOf(frame.send(key, gatewayCharge(gateway)));
    TakenOverOutboundCallRepository.isUnreadable = false;

    expect(failed).toMatchObject({ supersededBy: undefined });
    expect(frame.logger.entries).toContainEqual(
      expect.objectContaining({
        code: "outbound-call.superseded",
        message: expect.stringContaining(
          "(the intent could not be read: fenced-effect.invalid-name)",
        ) as unknown,
      }),
    );
  });
});

describe("#795 review: the trust is read once, as checked", () => {
  it("a notSent that turns into a Lookup after the check (a getter) is still a KeyReplay: the expired key is not resent", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, hours(25));
    let reads = 0;
    const options = {
      ...gatewayCharge(gateway, { reconcile: () => OutboundCallReconciliation.notSent() }),
      get notSent(): OutboundCallNotSent {
        reads += 1;
        return reads === 1
          ? { trust: NotSentTrust.KeyReplay, keyRetention: hours(24) }
          : { trust: NotSentTrust.Lookup };
      },
    };

    const refused = await rejectionOf(frame.send(key, options));

    expect(refused).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(gateway.payments).toHaveLength(1);
    expect(reads).toBe(1);
  });
});
