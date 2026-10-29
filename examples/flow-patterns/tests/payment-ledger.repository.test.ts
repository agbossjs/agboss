import { describe, expect } from "vitest";
import { SqliteConnection } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { PaymentKeyReusedError } from "../src/credit/errors/payment-key-reused.error.js";
import { PaymentLedgerRepository } from "../src/credit/repositories/payment-ledger.repository.js";
import { PaymentService } from "../src/credit/services/payment.service.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";

/**
 * #472: the offline payment provider's ledger on its own — one row per idempotency key, in one
 * instance and across two instances on the same SQLite file.
 */

const test = testWith(FlowPatternsApplication);

const record = (idempotencyKey: string, customerId: string, total: number) => ({
  idempotencyKey,
  customerId,
  total,
});

describe("#472: PaymentLedgerRepository", () => {
  test("recordOnce numbers new keys in order and answers a known key with its row", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);

    const first = ledger.recordOnce(record("k-1", "c-1", 50));
    const second = ledger.recordOnce(record("k-2", "c-1", 70));
    const repeated = ledger.recordOnce(record("k-1", "c-1", 50));

    expect(first).toEqual({ chargeNumber: 1, customerId: "c-1", total: 50 });
    expect(second).toEqual({ chargeNumber: 2, customerId: "c-1", total: 70 });
    expect(repeated).toEqual(first);
    expect(ledger.chargesOf("c-1")).toEqual([first, second]);
  });

  test("a known key with another customer or total keeps the first row unchanged", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    const first = ledger.recordOnce(record("k-1", "c-1", 50));

    expect(ledger.recordOnce(record("k-1", "c-2", 50))).toEqual(first);
    expect(ledger.recordOnce(record("k-1", "c-1", 60))).toEqual(first);
    expect(ledger.chargesOf("c-1")).toEqual([first]);
    expect(ledger.chargesOf("c-2")).toEqual([]);
  });

  test("chargesOf lists one customer's charges, oldest first, and none of another's", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    ledger.recordOnce(record("k-1", "c-1", 10));
    ledger.recordOnce(record("k-2", "c-2", 20));
    ledger.recordOnce(record("k-3", "c-1", 30));

    expect(ledger.chargesOf("c-1").map((row) => row.total)).toEqual([10, 30]);
    expect(ledger.chargesOf("c-2").map((row) => row.total)).toEqual([20]);
    expect(ledger.chargesOf("nobody")).toEqual([]);
  });

  test("chargesOf before any charge creates the table and finds nothing", async ({ app }) => {
    await app.ready();

    expect(app.resolve(PaymentLedgerRepository).chargesOf("c-1")).toEqual([]);
  });

  test("a row whose total is not a number is refused, never returned half-read", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    ledger.chargesOf("c-1");
    app
      .resolve(SqliteConnection)
      .database.prepare(
        "INSERT INTO payment_charges (idempotency_key, customer_id, total) VALUES (?, ?, ?)",
      )
      .run("k-bad", "c-1", "fifty");

    expect(() => ledger.chargesOf("c-1")).toThrow(/without its charge number, customer or total/);
    expect(() => ledger.recordOnce(record("k-bad", "c-1", 50))).toThrow(
      /without its charge number, customer or total/,
    );
  });
});

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
