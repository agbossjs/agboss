/**
 * #795 — the outbound-call contract fails closed. Every `sendOnce` declares how far its
 * `notExecuted()` is trusted (`recovery: OutboundRecovery.replayWithin(…)`, `.permanentLookup(…)`
 * or `.lookupWithin(…)`): leaving it out does not compile, and a JavaScript caller that leaves it
 * out, or gives a recovery or a window that is not one, is refused before anything is recorded or sent. An
 * attempt answered after a newer one took its intent over is an error, `OutboundCallError.Superseded`,
 * never a normal outcome. Settings built by hand say whether a request is stored only masked.
 */
import {
  IdempotencyError,
  OutboundCallError,
} from "../../src/core/error-families/effect-errors.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  InMemoryOutboundCallRepository,
  OutboundCallEventOutcome,
  OutboundCallSendStatus,
  OutboundRecovery,
  Reconciliation,
  type IdempotencySendOptions,
  type OutboundCallFailure,
} from "../../src/index.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { supersededError } from "../../src/app/outbound-call-errors.js";
import { type EffectKey } from "../../src/stores/index.js";
import { stateOf } from "../../src/app/outbound-call-business.js";
import { untilReached } from "../helpers/reached.js";
import {
  FakeGatewayFault,
  FakePaymentGateway,
} from "../../src/testing/gateway/fake-payment-gateway.js";
import { hours, minutes, seconds, type Milliseconds } from "../../src/units/index.js";
import {
  gatewayCharge,
  outboundFrame,
  rejectionOf,
  type GatewayChargeRequest,
  type GatewayPaymentReceipt,
  type OutboundFrame,
  type OutboundSendCase,
  lookupKeyOf,
} from "../helpers/outbound-frame.js";

type ChargeOptions = OutboundSendCase<GatewayChargeRequest, GatewayPaymentReceipt>;

/** A gateway with no lookup, keeping keys a day: a replay of the key is how it tells an outcome. */
const replayOnly = (frame: OutboundFrame) =>
  new FakePaymentGateway({
    clock: frame.clock,
    capabilities: { keyRetention: hours(24), lookupByKey: false },
  });

/** A charge left pending, its answer dropped after the gateway charged, and the clock `age` on. */
async function pendingFor(frame: OutboundFrame, gateway: FakePaymentGateway, age: Milliseconds) {
  const { key } = await frame.keyIn("execution-1");
  gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
  await rejectionOf(frame.send(key, gatewayCharge(gateway)));
  await frame.clock.advance(age);
  return key;
}

describe("#795 AC1: the recovery is required", () => {
  it("leaving recovery out, or a recovery that no OutboundRecovery factory made, does not compile", () => {
    const gateway = new FakePaymentGateway({ clock: outboundFrame().clock });
    const { recovery: _, ...withoutRecovery } = gatewayCharge(gateway);

    // @ts-expect-error — no recovery: the author must say how far a notExecuted() is trusted
    const missing: ChargeOptions = withoutRecovery;
    // @ts-expect-error — a look-alike object is no recovery: only OutboundRecovery's factories make one
    const lookalike: OutboundRecovery = { kind: "replay-within", keyTtl: hours(24) };

    expect([missing, lookalike]).toHaveLength(2);
    expectTypeOf<ChargeOptions["recovery"]>().toExtend<OutboundRecovery<GatewayPaymentReceipt>>();
  });

  const NOT_A_RECOVERY = "not one OutboundRecovery made";
  const NOT_A_DURATION = "not a positive, finite duration";
  const lookup = () => Reconciliation.notExecuted();
  // a JavaScript caller's values: anything at all where the recovery or its window goes
  const unmade = (kind: string, keyTtl: unknown) => ({
    ...OutboundRecovery.replayWithin(hours(24)),
    kind,
    keyTtl,
  });
  it.each([
    ["no recovery", undefined, `recovery is undefined, ${NOT_A_RECOVERY}`],
    ["a recovery of null", null, `recovery is null, ${NOT_A_RECOVERY}`],
    ["a recovery that is not an object", "lookup", `recovery is lookup, ${NOT_A_RECOVERY}`],
    [
      "an object no factory made",
      { kind: "replay-within", keyTtl: hours(24) },
      `recovery is an object, ${NOT_A_RECOVERY}`,
    ],
    [
      "a copy of a recovery (a spread drops the mark)",
      unmade("replay-within", hours(24)),
      `recovery is an object, ${NOT_A_RECOVERY}`,
    ],
    [
      "a null-prototype object (its text cannot be made)",
      Object.create(null) as unknown,
      `recovery is an object, ${NOT_A_RECOVERY}`,
    ],
    [
      "a window that is an object",
      OutboundRecovery.replayWithin(Object.create(null) as Milliseconds),
      `the key window is an object, ${NOT_A_DURATION}`,
    ],
    [
      "a window that is a text",
      OutboundRecovery.replayWithin("86400000" as never),
      `the key window is 86400000, ${NOT_A_DURATION}`,
    ],
    [
      "a zero window",
      OutboundRecovery.replayWithin(0 as Milliseconds),
      `the key window is 0, ${NOT_A_DURATION}`,
    ],
    [
      "a negative window",
      OutboundRecovery.lookupWithin(-1 as Milliseconds, lookup),
      `the key window is -1, ${NOT_A_DURATION}`,
    ],
    [
      "a window NaN",
      OutboundRecovery.replayWithin(Number.NaN as Milliseconds),
      `the key window is NaN, ${NOT_A_DURATION}`,
    ],
    [
      "an infinite window",
      OutboundRecovery.lookupWithin(Number.POSITIVE_INFINITY as Milliseconds, lookup),
      `the key window is Infinity, ${NOT_A_DURATION}`,
    ],
    [
      "a window not above the call's timeout",
      OutboundRecovery.replayWithin(seconds(15)),
      "the key window (15000 ms) is not above the call's timeout (15000 ms): a crash could never be reconciled inside it",
    ],
    [
      "a ttl below the window",
      OutboundRecovery.replayWithin(hours(72)),
      "the call's ttl (172800000 ms) is below the key window (259200000 ms)",
    ],
  ])(
    "a JavaScript caller with %s is refused: nothing recorded, nothing sent",
    async (_, recovery, problem) => {
      const frame = outboundFrame();
      const gateway = new FakePaymentGateway({ clock: frame.clock });
      const { key } = await frame.keyIn("execution-1");
      const options: ChargeOptions = { ...gatewayCharge(gateway), recovery: recovery as never };

      const refused = await rejectionOf(frame.send(key, options));

      expect(refused).toBeInstanceOf(OutboundCallError.InvalidRecovery);
      expect(refused).toMatchObject({
        code: "outbound-call.invalid-recovery",
        name: "OutboundCallError.InvalidRecovery",
        call: "charge",
        problem,
        details: { call: "charge" },
        message: `outbound call "charge" was refused: ${problem} — recovery: OutboundRecovery.replayWithin(hours(24)), .permanentLookup(…) or .lookupWithin(hours(24), …); nothing was recorded or sent`,
      });
      expect(gateway.payments).toEqual([]);
      expect(await frame.store.findByKey(lookupKeyOf(key))).toBeUndefined();
      expect(frame.reports).toEqual([]);
    },
  );

  it("a window just above the call's timeout is one: sent", async () => {
    const frame = outboundFrame();
    const gateway = new FakePaymentGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");
    const recovery = OutboundRecovery.replayWithin((seconds(15) + 1) as Milliseconds);

    expect(await frame.send(key, gatewayCharge(gateway, { recovery }))).toMatchObject({
      status: OutboundCallSendStatus.Sent,
    });
  });

  it("Lookup: the lookup is authoritative — a notSent() days later is sent again under the key", async () => {
    const frame = outboundFrame();
    const gateway = new FakePaymentGateway({ clock: frame.clock });
    const key = await pendingFor(frame, gateway, hours(72));
    const recovery = OutboundRecovery.permanentLookup<GatewayPaymentReceipt>(() =>
      Reconciliation.notExecuted(),
    );

    const outcome = await frame.send(key, gatewayCharge(gateway, { recovery }));

    expect(outcome).toMatchObject({ status: OutboundCallSendStatus.Sent, attempt: 2 });
  });

  it("KeyReplay: the same notSent() past the key's retention is refused — one payment, the bite of a fail-open default", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, hours(25));
    const replay = gatewayCharge(gateway, { recovery: OutboundRecovery.replayWithin(hours(24)) });

    const refused = await rejectionOf(frame.send(key, replay));

    expect(refused).toBeInstanceOf(OutboundCallError.Unreconciled);
    expect(gateway.payments).toHaveLength(1);
  });

  it("KeyReplay inside the retention: sent again, the gateway replays its key (one payment)", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, minutes(10));
    const replay = gatewayCharge(gateway, { recovery: OutboundRecovery.replayWithin(hours(24)) });

    expect(await frame.send(key, replay)).toMatchObject({ attempt: 2 });
    expect(gateway.payments).toHaveLength(1);
  });
});

describe("#795 AC3: OutboundCallError.Superseded", () => {
  it("is an OutboundCallError with a literal code; Superseded is no outcome status", () => {
    expect(OutboundCallError.Superseded.code).toBe("outbound-call.superseded");
    expect(Object.values(OutboundCallSendStatus)).not.toContain("superseded");
    const error = supersededError({
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "k-1",
      attempt: 1,
      supersededBy: 2,
    });

    expectTypeOf(error.code).toEqualTypeOf<"outbound-call.superseded">();
    expect(error).toBeInstanceOf(OutboundCallError);
    expect(error.name).toBe("OutboundCallError.Superseded");
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
  });

  it("the newer attempt unknown: supersededBy is undefined, never a guess", () => {
    const error = supersededError({
      call: "charge",
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
    const unsaid = new OutboundMasking({});

    expect(unsaid).toBeInstanceOf(OutboundMasking);
    expect(new OutboundMasking().requiresMask).toBe(true); // none given: masked
    expect(new OutboundMasking({ requiresMask: false }).requiresMask).toBe(false);
  });

  it.each([
    ["no options at all", undefined],
    ["no requiresMask", {}],
    ["a requiresMask that is not a boolean", { requiresMask: "no" }],
  ])("a JavaScript caller with %s requires the mask", (_, options) => {
    // a JavaScript caller's options: anything at all, or none
    expect(new OutboundMasking(options as never).requiresMask).toBe(true);
  });
});

/** A rival that takes the intent over (attempt + 1) right before this attempt's end is written. */
class TakenOverOutboundCallRepository extends InMemoryOutboundCallRepository {
  /** Whether a read after the takeover fails (the report's read of the newer attempt). */
  static isUnreadable = false;
  #isTakenOver = false;

  override async markCompleted(key: EffectKey, owner: string, result: string) {
    await this.#takeOver(key);
    return super.markCompleted(key, owner, result, null);
  }

  override async markFailed(key: EffectKey, owner: string, failure: OutboundCallFailure) {
    await this.#takeOver(key);
    return super.markFailed(key, owner, failure, null);
  }

  override findByKey(key: EffectKey) {
    if (this.#isTakenOver && TakenOverOutboundCallRepository.isUnreadable)
      return Promise.reject(new IdempotencyError.InvalidName({ length: 0 }));
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
  it("a definite failure answered after a newer attempt took over: OutboundCallError.Superseded, the decline its cause", async () => {
    TakenOverOutboundCallRepository.isUnreadable = false;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakePaymentGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");
    const declined = new Error("card declined");
    const options = gatewayCharge(gateway, {
      send: () => Promise.reject(declined),
      isDefiniteFailure: () => true,
    });

    const failed = await rejectionOf(frame.send(key, options));

    expect(failed).toBeInstanceOf(OutboundCallError.Superseded);
    expect(failed).toMatchObject({ attempt: 1, supersededBy: 2, cause: declined });
    expect(frame.logger.entries.map((entry) => [entry.code, entry.message])).toContainEqual([
      "outbound-call.superseded",
      'outbound call "charge" (charge on gateway) attempt 1 was answered after attempt 2 took its intent over: both reached gateway — check it there',
    ]);
    expect(frame.reports.at(-1)?.outcome).toBe(OutboundCallEventOutcome.AttemptSuperseded);
  });

  it("a call joined to a superseded one shares its error: nothing sent again, one charge", async () => {
    TakenOverOutboundCallRepository.isUnreadable = false;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakePaymentGateway({ clock: frame.clock });
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

    expect(await first).toBeInstanceOf(OutboundCallError.Superseded);
    expect(await joined).toBeInstanceOf(OutboundCallError.Superseded);
    expect(gateway.payments).toHaveLength(1);
  });

  it("the report's read of the newer attempt fails: named on the log by its code, the error thrown all the same", async () => {
    TakenOverOutboundCallRepository.isUnreadable = true;
    const frame = outboundFrame({ store: TakenOverOutboundCallRepository });
    const gateway = new FakePaymentGateway({ clock: frame.clock });
    const { key } = await frame.keyIn("execution-1");

    const failed = await rejectionOf(frame.send(key, gatewayCharge(gateway)));
    TakenOverOutboundCallRepository.isUnreadable = false;

    expect(failed).toMatchObject({ supersededBy: undefined });
    expect(frame.logger.entries).toContainEqual(
      expect.objectContaining({
        code: "outbound-call.superseded",
        message: expect.stringContaining(
          "(the intent could not be read: idempotency.invalid-name)",
        ) as unknown,
      }),
    );
  });
});

describe("#795 review: the trust is read once, as checked", () => {
  it("a recovery that turns into a lookup after the check (a getter) is still a replay: the expired key is not resent", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await pendingFor(frame, gateway, hours(25));
    let reads = 0;
    const options = {
      ...gatewayCharge(gateway),
      get recovery(): OutboundRecovery<GatewayPaymentReceipt> {
        reads += 1;
        return reads === 1
          ? OutboundRecovery.replayWithin(hours(24))
          : OutboundRecovery.permanentLookup(() => Reconciliation.notExecuted());
      },
    };

    const refused = await rejectionOf(frame.send(key, options));

    expect(refused).toBeInstanceOf(OutboundCallError.Unreconciled);
    expect(gateway.payments).toHaveLength(1);
    expect(reads).toBe(1);
  });
});
