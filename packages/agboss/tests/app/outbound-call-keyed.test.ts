/**
 * #626 — how a call's key gets its fingerprint and when an intent left pending under the caller's
 * own lease is reconciled, each found by a mutant that lived: a step's key never gets a
 * fingerprint; a business key's fingerprint is the request's (a call has no other, #1317); a
 * business key's intent left pending by an earlier attempt of this same step — its owner gone, its
 * lease the caller's — is reconciled here, never taken for in flight.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  Idempotency,
  OutboundCallRepository,
  OutboundRecovery,
  type OutboundCallRecord,
  type Produced,
} from "../../src/index.js";
import { effectKeyOf } from "../../src/stores/index.js";
import { testUnit } from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { ChargeReceiptDto } from "./fixtures/outbound-call.workflow.js";
import { gateway, letChargesGo, PaymentGateway, resetGateway } from "./fixtures/payment-gateway.js";
import { lookupKeyOf } from "../helpers/outbound-frame.js";

/** What the next run charges, and under which key. */
const next = {
  amountUsd: 10,
  key: undefined as string | undefined,
  found: [] as (OutboundCallRecord | undefined)[],
};

@Action({
  name: "keyed-charge-action",
  description: "Charges an order under a step key or a business key, then reads its intent back",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, Idempotency, PaymentGateway, OutboundCallRepository],
})
class KeyedChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
    private readonly repository: OutboundCallRepository,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const orderId = input.message.value.text;
    const outcome = await this.idempotency.sendOnce({
      name: "charge",
      ...(next.key === undefined ? {} : { key: next.key }),
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd: next.amountUsd },
      send: (call) => this.paymentGateway.charge(call),
      timeout: seconds(15),
      ttl: hours(48),
      recovery: OutboundRecovery.permanentLookup((call) => this.paymentGateway.reconcile(call)),
    });
    const key = effectKeyOf(
      this.executionContext,
      "charge",
      next.key === undefined ? undefined : { businessKey: next.key },
    );
    // the store is read by the key's identity — under a business key, with a fingerprint (#825)
    next.found.push(await this.repository.findByKey(lookupKeyOf(key)));
    return { chargeId: outcome.result.chargeId };
  }
}

const order = { message: { value: { text: "order-1" } } } as never;

beforeEach(() => {
  resetGateway();
  Object.assign(next, { amountUsd: 10, key: undefined, found: [] });
});

afterEach(letChargesGo);

describe("#626: a call's fingerprint", () => {
  it("a step's key is stored with no fingerprint", async () => {
    await testUnit(KeyedChargeAction)(order);

    expect(next.found).toHaveLength(1);
    expect(next.found[0]).not.toHaveProperty("fingerprint");
  });

  it("the request's: another request under the business key is a conflict", async () => {
    next.key = "order:1";
    const run = testUnit(KeyedChargeAction);
    await run(order);
    next.amountUsd = 12;

    await expect(run(order)).rejects.toBeInstanceOf(IdempotencyError.KeyConflict);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("#626: a business key's intent left pending under the caller's own lease", () => {
  it("its owner gone (the attempt timed out), the step run again reconciles it and sends it once", async () => {
    next.key = "order:1";
    const run = testUnit(KeyedChargeAction);
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
