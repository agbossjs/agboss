import { describe, expect } from "vitest";
import { IdempotencyError } from "@agboss/core";
import { SqliteConnection } from "@agboss/core/stores";
import { testWith } from "@agboss/core/testing";
import { PaymentLedgerRepository } from "../../../src/credit/repositories/payment-ledger.repository.js";
import { FlowPatternsApplication } from "../../../src/flow-patterns.application.js";

/**
 * #500: the offline payment provider's ledger on its own — one row per charge, written in a
 * transaction (a `runOnce`'s in the application; here the connection's own `held`, #1317c).
 */

const test = testWith(FlowPatternsApplication);

describe("#500: PaymentLedgerRepository", () => {
  test("recordCharge outside a runOnce is refused: it writes only in an effect's transaction", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);

    expect(() => ledger.recordCharge({ customerId: "c-1", total: 50 })).toThrow(
      IdempotencyError.OutsideTransaction,
    );
  });

  test("recordCharge numbers the charges in order and names each by its customer", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    const connection = app.resolve(SqliteConnection);

    const first = await connection.held(() =>
      ledger.recordCharge({ customerId: "c-1", total: 50 }),
    );
    const second = await connection.held(() =>
      ledger.recordCharge({ customerId: "c-2", total: 70 }),
    );

    expect(first).toEqual({ chargeId: "charge-c-1-1" });
    expect(second).toEqual({ chargeId: "charge-c-2-2" });
    expect(ledger.chargesOf("c-1")).toEqual([{ chargeNumber: 1, customerId: "c-1", total: 50 }]);
  });

  test("chargesOf lists one customer's charges, oldest first, and none of another's", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    await app.resolve(SqliteConnection).held(() => {
      ledger.recordCharge({ customerId: "c-1", total: 10 });
      ledger.recordCharge({ customerId: "c-2", total: 20 });
      ledger.recordCharge({ customerId: "c-1", total: 30 });
    });

    expect(ledger.chargesOf("c-1").map((row) => row.total)).toEqual([10, 30]);
    expect(ledger.chargesOf("c-2").map((row) => row.total)).toEqual([20]);
    expect(ledger.chargesOf("nobody")).toEqual([]);
  });

  test("a row whose total is not a number is refused, never returned half-read", async ({
    app,
  }) => {
    await app.ready();
    const ledger = app.resolve(PaymentLedgerRepository);
    app
      .resolve(SqliteConnection)
      .database.prepare("INSERT INTO payment_charges (customer_id, total) VALUES (?, ?)")
      .run("c-1", "fifty");

    expect(() => ledger.chargesOf("c-1")).toThrow(
      "payment_charges: a row without its charge number, customer or total",
    );
  });
});
