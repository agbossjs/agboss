import { describe, expect } from "vitest";
import { SqliteConnection } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { PaymentLedgerRepository } from "../../../src/credit/repositories/payment-ledger.repository.js";
import { FlowPatternsApplication } from "../../../src/flow-patterns.application.js";

/**
 * #472: the offline payment provider's ledger on its own — one row per idempotency key.
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
