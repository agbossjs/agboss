/**
 * #508 — the window between recording an intent and sending it: the attempt's owner is live in this
 * instance from before the intent is recorded, so a second call of the key arriving in the window
 * joins the first and is never sent; a step aborted in the window sends nothing. The window is
 * held open by a gate at the store, after the intent is recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  ExecutionLeaseRepository,
  fencedEffectKeyOf,
  Injectable,
  InMemoryOutboundCallRepository,
  OutboundCallOutcomeStatus,
  OutboundCallRepository,
  OutboundCalls,
  type FencedEffectKey,
  type OutboundCallIntent,
} from "../../src/index.js";
import { Clock } from "../../src/infrastructure/clock.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { override, testAction } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { settle } from "./fixtures/fence-takeover.js";
import { gateway, PaymentGateway, resetGateway } from "./fixtures/payment-gateway.js";

/** The gate after the intent is recorded: armed, reached, let go. */
const window = {
  isArmed: false,
  reached: undefined as (() => void) | undefined,
  letGo: undefined as (() => void) | undefined,
};

const reachedWindow = (): Promise<void> =>
  new Promise((resolve) => {
    window.reached = resolve;
  });

@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
class GatedOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent): Promise<boolean> {
    const isSaved = await super.saveIfAbsent(key, intent);
    if (!window.isArmed) return isSaved;
    window.isArmed = false;
    await new Promise<void>((resolve) => {
      window.letGo = resolve;
      window.reached?.();
    });
    return isSaved;
  }
}

/** What the second call of the action got. */
const seen = { statuses: [] as OutboundCallOutcomeStatus[] };

const charge = (outboundCalls: OutboundCalls, gatewayOf: PaymentGateway, key: FencedEffectKey) =>
  outboundCalls.send(key, {
    target: "payments",
    operation: "charge",
    request: { orderId: "order-1", amountUsd: 10 },
    send: (call) => gatewayOf.charge(call),
    reconcile: (lookup) => gatewayOf.reconcile(lookup),
  });

@Action({
  name: "charge-in-window-action",
  description: "Charges an order, and once more while the first charge is in its window",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
class ChargeInWindowAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const key = fencedEffectKeyOf(this.executionContext, "charge", { businessKey: "order:1" });
    window.isArmed = true;
    const reached = reachedWindow();
    const first = charge(this.outboundCalls, this.paymentGateway, key);
    await reached;
    const second = charge(this.outboundCalls, this.paymentGateway, key);
    window.letGo?.();
    const outcomes = await Promise.all([first, second]);
    seen.statuses.push(...outcomes.map((outcome) => outcome.status));
  }
}

@Action({
  name: "charge-once-action",
  description: "Charges an order once",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
class ChargeOnceAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const key = fencedEffectKeyOf(this.executionContext, "charge", { businessKey: "order:1" });
    await charge(this.outboundCalls, this.paymentGateway, key);
  }
}

const order = { message: { value: { text: "order-1" } } } as never;
const gated = { overrides: [override(OutboundCallRepository, GatedOutboundCallRepository)] };

beforeEach(() => {
  resetGateway();
  seen.statuses.length = 0;
  Object.assign(window, { isArmed: false, reached: undefined, letGo: undefined });
});

afterEach(() => {
  window.letGo?.();
});

describe("#508: the window between recording an intent and sending it", () => {
  it("a second call of the key arriving between the save and the send is joined, never sent", async () => {
    const run = testAction(ChargeInWindowAction, gated);

    await run(order);

    expect(seen.statuses).toEqual([
      OutboundCallOutcomeStatus.Sent,
      OutboundCallOutcomeStatus.Joined,
    ]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("a step aborted in the window — after its intent is recorded, before its send — sends nothing", async () => {
    const run = testAction(ChargeOnceAction, gated);
    window.isArmed = true;
    const reached = reachedWindow();
    const call = run(order, { timeout: seconds(1) });
    call.catch(() => undefined);
    await reached;

    await run.clock.advance(seconds(1));
    await expect(call).rejects.toThrow();
    window.letGo?.();
    await settle();

    expect(gateway.calls).toEqual([]);
  });
});
