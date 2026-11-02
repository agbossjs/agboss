/**
 * #658 — `reconcile` is told when the pending attempt started (`lookup.attemptStartedAt`, the
 * store's clock) and how old the call's key is (`lookup.keyAge`, from its first attempt), and a call
 * that declares the other system's `keyRetention` never sends a `notSent()` again once the key, plus
 * `attemptTimeout`, is past it: `OutboundCallUnreconciledError`, nothing sent, the intent pending.
 * On `FakeOutboundGateway` with no lookup — a replay of the key its only way to learn an outcome —
 * the clock past the retention: one charge (AC1); without the declaration, two (the bite).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryOutboundCallRepository,
  OutboundCallEventOutcome,
  OutboundCallOutcomeStatus,
  OutboundCallReconciliation,
  OutboundCallStatus,
  OutboundCallUnreconciledError,
  type FencedEffectKey,
  type OutboundCallLookup,
  type OutboundCallRecord,
} from "../../src/index.js";
import { ClockSkew, SkewedClock } from "../../src/testing/clock-skew.js";
import {
  FakeGatewayFault,
  FakeOutboundGateway,
} from "../../src/testing/gateway/fake-outbound-gateway.js";
import { hours, minutes, type Milliseconds } from "../../src/units/index.js";
import {
  gatewayCharge,
  outboundFrame,
  rejectionOf,
  type OutboundFrame,
} from "../helpers/outbound-frame.js";

/** A gateway with no lookup, keeping keys a day: a replay of the key is how it tells an outcome. */
const replayOnly = (frame: OutboundFrame) =>
  new FakeOutboundGateway({
    clock: frame.clock,
    capabilities: { keyRetention: hours(24), lookupByKey: false },
  });

/** A reconcile of a replay-only gateway: always "send it again under the key", each lookup kept. */
const replaying = (lookups: OutboundCallLookup[]) => (lookup: OutboundCallLookup) => {
  lookups.push(lookup);
  return OutboundCallReconciliation.notSent();
};

/** A charge left pending at the store's `now`: its answer dropped after the gateway charged. */
async function leftPending(
  frame: OutboundFrame,
  gateway: FakeOutboundGateway,
): Promise<FencedEffectKey> {
  const { key } = await frame.keyIn("execution-1");
  gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
  await rejectionOf(frame.send(key, gatewayCharge(gateway)));
  return key;
}

describe("#658 AC1: the lookup says when the attempt started and how old the key is", () => {
  it("attemptStartedAt is the claim on the store's clock; keyAge counts from the first attempt, after a second one too", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const lookups: OutboundCallLookup[] = [];
    const first = frame.clock.now();
    const key = await leftPending(frame, gateway);
    await frame.clock.advance(minutes(10));
    gateway.injectFault(FakeGatewayFault.AnswerThenDrop);
    const options = gatewayCharge(gateway, { reconcile: replaying(lookups) });
    await rejectionOf(frame.send(key, options));
    const second = frame.clock.now();
    await frame.clock.advance(minutes(5));

    await frame.send(key, options);

    expect(
      lookups.map((lookup) => [lookup.attempt, lookup.attemptStartedAt, lookup.keyAge]),
    ).toEqual([
      [1, first, minutes(10)],
      [2, second, minutes(15)],
    ]);
  });

  it("an instance whose wall clock is two days ahead reads the same times and ages: the store's clock decides", async () => {
    const frame = outboundFrame({
      instanceClock: (clock) => new SkewedClock(clock, ClockSkew.ahead(hours(48))),
    });
    const gateway = replayOnly(frame);
    const lookups: OutboundCallLookup[] = [];
    const started = frame.clock.now();
    const key = await leftPending(frame, gateway);
    await frame.clock.advance(minutes(3));

    await frame.send(key, gatewayCharge(gateway, { reconcile: replaying(lookups) }));

    expect([lookups[0]?.attemptStartedAt, lookups[0]?.keyAge]).toEqual([started, minutes(3)]);
  });
});

describe("#658: keyRetention — a notSent() past the key's retention is refused, nothing sent", () => {
  const RETENTION = hours(24);
  const MARGIN = minutes(2); // outboundCalls.attemptTimeout: how long a resend may take to arrive

  /** The verdict on a key `age` old (`null`: no keyRetention): a resend, or the refusal. */
  async function resendAt(age: Milliseconds, keyRetention: Milliseconds | null = RETENTION) {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await leftPending(frame, gateway);
    await frame.clock.advance(age);
    const options = gatewayCharge(gateway, {
      reconcile: replaying([]),
      ...(keyRetention === null ? {} : { keyRetention }),
    });
    const outcome = await frame.send(key, options).catch((error: unknown) => error);
    return { frame, gateway, key, outcome };
  }

  it("1 ms inside: age + attemptTimeout below the retention — sent again, the gateway replays it (one payment)", async () => {
    const { outcome, gateway } = await resendAt((RETENTION - MARGIN - 1) as Milliseconds);

    expect(outcome).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
    expect(gateway.payments).toHaveLength(1);
  });

  it("at the edge: age + attemptTimeout equal to the retention — refused, the intent pending at attempt 1, told Unknown", async () => {
    const { outcome, gateway, frame, key } = await resendAt((RETENTION - MARGIN) as Milliseconds);

    expect(outcome).toBeInstanceOf(OutboundCallUnreconciledError);
    expect((outcome as OutboundCallUnreconciledError).reason).toMatch(
      /notSent\(\), but the key was first sent 86280000 ms ago; gateway keeps keys for 86400000 ms \(keyRetention\), and a resend may take 120000 ms to arrive \(attemptTimeout\)/u,
    );
    expect(gateway.payments).toHaveLength(1);
    expect(await frame.store.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Pending,
      attempt: 1,
    });
    expect(frame.reports.at(-1)?.outcome).toBe(OutboundCallEventOutcome.Unknown);
  });

  it("#658 AC1: the clock past the retention — refused, one payment; the bite: undeclared, the replay is a new charge (two)", async () => {
    const declared = await resendAt(hours(25));
    const undeclared = await resendAt(hours(25), null);

    expect(declared.outcome).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(declared.gateway.payments).toHaveLength(1);
    expect(undeclared.outcome).toMatchObject({ status: OutboundCallOutcomeStatus.Sent });
    expect(undeclared.gateway.payments).toHaveLength(2);
  });

  it.each([
    ["not a number", Number.NaN],
    ["negative", -1],
  ])("a keyRetention %s refuses every resend", async (_, keyRetention) => {
    const { outcome } = await resendAt(minutes(1), keyRetention as Milliseconds);

    expect(outcome).toBeInstanceOf(OutboundCallUnreconciledError);
  });

  it("the time reconcile itself takes ages the key: measured again after it answers", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await leftPending(frame, gateway);
    await frame.clock.advance(hours(23));
    const slow = async () => {
      await frame.clock.advance(hours(1));
      return OutboundCallReconciliation.notSent();
    };

    const outcome = await rejectionOf(
      frame.send(key, gatewayCharge(gateway, { reconcile: slow, keyRetention: RETENTION })),
    );

    expect(outcome).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(gateway.payments).toHaveLength(1);
  });

  it("a reconcile that uses lookup.keyAge itself answers unknown past the retention: nothing sent, one charge", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const key = await leftPending(frame, gateway);
    await frame.clock.advance(hours(25));
    const reconcile = (lookup: OutboundCallLookup) =>
      lookup.keyAge !== undefined && lookup.keyAge < RETENTION
        ? OutboundCallReconciliation.notSent()
        : OutboundCallReconciliation.unknown({ reason: "the key may have expired" });

    const outcome = await rejectionOf(frame.send(key, gatewayCharge(gateway, { reconcile })));

    expect(outcome).toMatchObject({ reason: "the key may have expired" });
    expect(gateway.payments).toHaveLength(1);
  });

  it("a definite failure is sent again at any age: nothing moved, so nothing to replay", async () => {
    const frame = outboundFrame();
    const gateway = replayOnly(frame);
    const { key } = await frame.keyIn("execution-1");
    gateway.injectFault(FakeGatewayFault.FailBeforeProcessing);
    const options = gatewayCharge(gateway, {
      isDefiniteFailure: () => true,
      keyRetention: RETENTION,
    });
    await rejectionOf(frame.send(key, options));
    await frame.clock.advance(hours(48));

    expect(await frame.send(key, options)).toMatchObject({
      status: OutboundCallOutcomeStatus.Sent,
    });
    expect(gateway.payments).toHaveLength(1);
  });
});

/** A store that keeps intents as one written before 0.1.1: no attempt times. */
class TimelessOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    const found = await super.findByKey(key);
    if (found === undefined) return undefined;
    const old: { -readonly [K in keyof OutboundCallRecord]: OutboundCallRecord[K] } = { ...found };
    delete old.attemptStartedAt;
    delete old.firstAttemptStartedAt;
    return old;
  }
}

/** A store whose read by key does not say when it read: the key's age cannot be measured. */
class UndatedReadOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    const found = await super.findByKey(key);
    if (found === undefined) return undefined;
    const undated: { -readonly [K in keyof OutboundCallRecord]: OutboundCallRecord[K] } = {
      ...found,
    };
    delete undated.readAt;
    return undated;
  }
}

describe("#658: an intent whose times were not recorded", () => {
  it("a read that says not when it read: the attempt's start told, its key's age unknown — refused with keyRetention", async () => {
    const frame = outboundFrame({ store: UndatedReadOutboundCallRepository });
    const gateway = replayOnly(frame);
    const lookups: OutboundCallLookup[] = [];
    const started = frame.clock.now();
    const key = await leftPending(frame, gateway);

    const refused = await rejectionOf(
      frame.send(
        key,
        gatewayCharge(gateway, { reconcile: replaying(lookups), keyRetention: hours(24) }),
      ),
    );

    expect([lookups[0]?.attemptStartedAt, lookups[0]?.keyAge]).toEqual([started, undefined]);
    expect(refused).toBeInstanceOf(OutboundCallUnreconciledError);
  });

  it("the lookup has neither; with keyRetention the resend is refused (the age unknown), without it, sent", async () => {
    const frame = outboundFrame({ store: TimelessOutboundCallRepository });
    const gateway = replayOnly(frame);
    const lookups: OutboundCallLookup[] = [];
    const key = await leftPending(frame, gateway);
    const declared = gatewayCharge(gateway, {
      reconcile: replaying(lookups),
      keyRetention: hours(24),
    });

    const refused = await rejectionOf(frame.send(key, declared));
    const sent = await frame.send(key, gatewayCharge(gateway, { reconcile: replaying(lookups) }));

    expect(lookups.map((lookup) => [lookup.attemptStartedAt, lookup.keyAge])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect((refused as OutboundCallUnreconciledError).reason).toMatch(
      /when the key was first sent is not recorded/u,
    );
    expect(sent.status).toBe(OutboundCallOutcomeStatus.Sent);
  });
});
