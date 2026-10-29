import { describe, expect } from "vitest";
import { testWith } from "@agboss/core/testing";
import { PaymentKeyReusedError } from "../../../src/credit/errors/payment-key-reused.error.js";
import { PaymentLedgerRepository } from "../../../src/credit/repositories/payment-ledger.repository.js";
import { PaymentService } from "../../../src/credit/services/payment.service.js";
import { FlowPatternsApplication } from "../../../src/flow-patterns.application.js";

/**
 * #472: the offline payment provider on its own — one charge per idempotency key, in one instance
 * and across two instances on the same SQLite file.
 */

const test = testWith(FlowPatternsApplication);

describe("#472: PaymentService", () => {
  test("names a charge by its customer and its ledger number", async ({ app }) => {
    await app.ready();
    const payments = app.resolve(PaymentService);

    const first = await payments.charge({ customerId: "c-1", total: 50, idempotencyKey: "k-1" });
    const other = await payments.charge({ customerId: "c-2", total: 50, idempotencyKey: "k-2" });
    const retry = await payments.charge({ customerId: "c-1", total: 50, idempotencyKey: "k-1" });

    expect(first).toEqual({ chargeId: "charge-c-1-1" });
    expect(other).toEqual({ chargeId: "charge-c-2-2" });
    expect(retry).toEqual(first);
  });

  test("a reused key rejects with PaymentKeyReusedError naming the key; no row is added", async ({
    app,
  }) => {
    await app.ready();
    const payments = app.resolve(PaymentService);
    await payments.charge({ customerId: "c-1", total: 50, idempotencyKey: "k-1" });

    const reused = payments.charge({ customerId: "c-1", total: 99, idempotencyKey: "k-1" });

    await expect(reused).rejects.toBeInstanceOf(PaymentKeyReusedError);
    await expect(reused).rejects.toMatchObject({
      code: "payment.key-reused",
      idempotencyKey: "k-1",
      message: "idempotency key k-1 was used for another charge",
    });
    expect(app.resolve(PaymentLedgerRepository).chargesOf("c-1")).toHaveLength(1);
  });
});

const instances = testWith(FlowPatternsApplication, { instances: 2, env: "instances" });

describe("#472: two instances on one SQLite file", () => {
  instances("the same key from both instances is one charge, seen by both", async ({ apps }) => {
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances expected");
    await Promise.all([first.ready(), second.ready()]);
    const customerId = `c-shared-${String(Date.now())}`;
    const key = `k-shared-${customerId}`;

    const [one, other] = await Promise.all([
      first.resolve(PaymentService).charge({ customerId, total: 50, idempotencyKey: key }),
      second.resolve(PaymentService).charge({ customerId, total: 50, idempotencyKey: key }),
    ]);

    expect(other).toEqual(one);
    expect(first.resolve(PaymentLedgerRepository).chargesOf(customerId)).toHaveLength(1);
    expect(second.resolve(PaymentLedgerRepository).chargesOf(customerId)).toHaveLength(1);
  });
});
