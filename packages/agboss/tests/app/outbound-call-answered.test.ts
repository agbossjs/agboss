/**
 * #928 (reviewer hole 3) — `isAnswered` is set only after the end of the attempt is written
 * (`fencedEnd` resolved): a call joined to one whose `markFailed` did not get through is not handed
 * the other system's error as the answer of its own — it makes the call itself and reconciles the
 * intent that stayed `Pending`. The provider is asked for one charge, never two.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  ExecutionLeaseLostError,
  InMemoryOutboundCallRepository,
  Injectable,
  NotSentTrust,
  OutboundCallRepository,
  OutboundCalls,
  effectKeyOf,
} from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { StoreClock } from "../../src/infrastructure/clock.js";
import { override, testAction } from "../../src/testing/index.js";
import {
  gateway,
  isDeclined,
  letChargesGo,
  PaymentDeclinedError,
  PaymentGateway,
  resetGateway,
} from "./fixtures/payment-gateway.js";

/** What each of the step's two calls came to. */
const settled: PromiseSettledResult<unknown>[] = [];
const store = { failMarkFailed: true };

beforeEach(() => {
  resetGateway();
  settled.length = 0;
  store.failMarkFailed = true;
});

afterEach(letChargesGo);

/** An intent store whose first `markFailed` does not get through: an error that proves nothing. */
@Injectable({ deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
class DownOnFailedStore extends InMemoryOutboundCallRepository {
  override markFailed(...args: Parameters<InMemoryOutboundCallRepository["markFailed"]>) {
    if (!store.failMarkFailed) return super.markFailed(...args);
    store.failMarkFailed = false;
    return Promise.reject(new Error("the store went down"));
  }
}

@Action({
  name: "declined-twice-action",
  description: "Sends one call from two places of one step at once; the provider declines",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
class DeclinedTwiceAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(_input: object): Promise<void> {
    const key = effectKeyOf(this.executionContext, "charge");
    const options = {
      target: "payments",
      operation: "charge",
      request: { orderId: "order-2", amountUsd: 10 },
      send: (call: Parameters<PaymentGateway["charge"]>[0]) => this.paymentGateway.charge(call),
      notSent: { trust: NotSentTrust.Lookup } as const,
      reconcile: (lookup: Parameters<PaymentGateway["reconcile"]>[0]) =>
        this.paymentGateway.reconcile(lookup),
      isDefiniteFailure: isDeclined,
    };
    settled.push(
      ...(await Promise.allSettled([
        this.outboundCalls.send(key, options),
        this.outboundCalls.send(key, options),
      ])),
    );
    await Promise.resolve();
  }
}

const lost = new ExecutionLeaseLostError({ rootExecutionId: "execution-1" });

@Action({
  name: "handed-over-twice-action",
  description: "Two calls of one key at once; the first one's send is handed over",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
class HandedOverTwiceAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(_input: object): Promise<void> {
    const key = effectKeyOf(this.executionContext, "charge");
    let sends = 0;
    const options = {
      target: "payments",
      operation: "charge",
      request: { orderId: "order-3", amountUsd: 10 },
      send: (call: Parameters<PaymentGateway["charge"]>[0]) => {
        sends += 1;
        return sends === 1 ? Promise.reject(lost) : this.paymentGateway.charge(call);
      },
      notSent: { trust: NotSentTrust.Lookup } as const,
      reconcile: (lookup: Parameters<PaymentGateway["reconcile"]>[0]) =>
        this.paymentGateway.reconcile(lookup),
    };
    settled.push(
      ...(await Promise.allSettled([
        this.outboundCalls.send(key, options),
        this.outboundCalls.send(key, options),
      ])),
    );
  }
}

describe("#928: a joined call never shares a handed-over error (sharedOf)", () => {
  it("the first call's hand-over is not the joiner's answer: it makes the call itself", async () => {
    const run = testAction(HandedOverTwiceAction);

    await run({});

    const [first, second] = settled;
    expect(first?.status === "rejected" ? first.reason : undefined).toBe(lost);
    expect(second?.status === "rejected" ? second.reason : undefined).not.toBe(lost);
  });
});

describe("#928: isAnswered only after fencedEnd resolves", () => {
  it("a definite failure whose markFailed did not get through is not the joined call's answer", async () => {
    gateway.failNext = 1;
    const run = testAction(DeclinedTwiceAction, {
      overrides: [override(OutboundCallRepository, DownOnFailedStore)],
    });

    await run({});

    const [first, second] = settled;
    expect(first?.status).toBe("rejected");
    expect(first?.status === "rejected" ? first.reason : undefined).toMatchObject({
      message: "the store went down",
    });
    // not shared: the joiner made the call itself and reconciled the intent that stayed Pending
    expect(second?.status === "rejected" ? second.reason : undefined).not.toBeInstanceOf(
      PaymentDeclinedError,
    );
    expect(second?.status === "rejected" ? second.reason : undefined).not.toMatchObject({
      message: "the store went down",
    });
  });

  it("a definite failure written and answered is shared with the joined call", async () => {
    store.failMarkFailed = false;
    gateway.failNext = 1;
    const run = testAction(DeclinedTwiceAction, {
      overrides: [override(OutboundCallRepository, DownOnFailedStore)],
    });

    await run({});

    expect(settled.map((one) => one.status)).toEqual(["rejected", "rejected"]);
    expect(gateway.calls).toHaveLength(1);
  });
});
