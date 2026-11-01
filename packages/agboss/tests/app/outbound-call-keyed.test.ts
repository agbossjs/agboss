/**
 * #626 — how a call's key gets its fingerprint and when an intent left pending under the caller's
 * own lease is reconciled, each found by a mutant that lived: a step's key never gets a
 * fingerprint; a business key's own fingerprint is kept, never replaced by the request's; a
 * business key's intent left pending by an earlier attempt of this same step — its owner gone, its
 * lease the caller's — is reconciled here, never taken for in flight.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  fencedEffectKeyOf,
  IdempotencyKeyConflictError,
  OutboundCallRepository,
  OutboundCalls,
  type OutboundCallRecord,
  type FencedEffectKeyOptions,
  type Produced,
} from "../../src/index.js";
import { testAction } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { ChargeReceiptDto } from "./fixtures/outbound-call.workflow.js";
import { gateway, letChargesGo, PaymentGateway, resetGateway } from "./fixtures/payment-gateway.js";

/** What the next run charges, and under which key. */
const next = {
  amountUsd: 10,
  options: undefined as FencedEffectKeyOptions<{ readonly version: number }> | undefined,
  found: [] as (OutboundCallRecord | undefined)[],
};

@Action({
  name: "keyed-charge-action",
  description: "Charges an order under a step key or a business key, then reads its intent back",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway, OutboundCallRepository],
})
class KeyedChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
    private readonly repository: OutboundCallRepository,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const orderId = input.message.value.text;
    const key = fencedEffectKeyOf(this.executionContext, "charge", next.options);
    const outcome = await this.outboundCalls.send(key, {
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd: next.amountUsd },
      send: (call) => this.paymentGateway.charge(call),
      reconcile: (call) => this.paymentGateway.reconcile(call),
    });
    next.found.push(await this.repository.findByKey(key));
    return { chargeId: outcome.result.chargeId };
  }
}

const order = { message: { value: { text: "order-1" } } } as never;

beforeEach(() => {
  resetGateway();
  Object.assign(next, { amountUsd: 10, options: undefined, found: [] });
});

afterEach(letChargesGo);

describe("#626: a call's fingerprint", () => {
  it("a step's key is stored with no fingerprint", async () => {
    await testAction(KeyedChargeAction)(order);

    expect(next.found).toHaveLength(1);
    expect(next.found[0]).not.toHaveProperty("fingerprint");
  });

  it("a business key's own fingerprint is kept: another request under it replays, never a conflict", async () => {
    next.options = { businessKey: "order:1", fingerprint: { version: 1 } };
    const run = testAction(KeyedChargeAction);
    const first = await run(order);
    next.amountUsd = 12;

    const second = await run(order);

    expect(second.output).toEqual(first.output);
    expect(gateway.calls).toHaveLength(1);
  });

  it("without one, the request's: another request under the business key is a conflict", async () => {
    next.options = { businessKey: "order:1" };
    const run = testAction(KeyedChargeAction);
    await run(order);
    next.amountUsd = 12;

    await expect(run(order)).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("#626: a business key's intent left pending under the caller's own lease", () => {
  it("its owner gone (the attempt timed out), the step run again reconciles it and sends it once", async () => {
    next.options = { businessKey: "order:1" };
    const run = testAction(KeyedChargeAction);
    gateway.gates.before = 1;
    const first = run(order, { timeout: seconds(1) });
    first.catch(() => undefined);
    await run.clock.advance(seconds(1));
    await expect(first).rejects.toThrow();

    const second = await run(order);

    expect(second.output).toMatchObject({ chargeId: expect.any(String) });
    expect(gateway.lookups).toHaveLength(1);
  });
});
