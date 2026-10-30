import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Injectable, SqliteConnection } from "@agboss/core";

/** The DDL of the ledger's table, applied once per connection. */
const SCHEMA: string = readFileSync(new URL("../sql/payment-charges.sql", import.meta.url), "utf8");

/** What a charge asks the payment provider: whom, how much (whole dollars). */
export interface PaymentOrder {
  readonly customerId: string;
  readonly total: number;
}

/** One charge of the ledger: its number, whom it charged and how much (whole dollars). */
export interface PaymentChargeRow extends PaymentOrder {
  readonly chargeNumber: number;
}

/** A charge the provider made: its receipt, what the fenced effect stores. */
export interface Charge {
  readonly chargeId: string;
}

/** A row read back from SQLite, checked field by field. */
function chargeRowOf(row: Record<string, unknown> | undefined): PaymentChargeRow {
  const { chargeNumber, customerId, total } = row ?? {};
  if (
    typeof chargeNumber !== "number" ||
    typeof customerId !== "string" ||
    typeof total !== "number"
  )
    throw new Error("payment_charges: a row without its charge number, customer or total");
  return { chargeNumber, customerId, total };
}

/**
 * The offline payment provider's ledger, in the application's SQLite file — a stand-in for a real
 * provider's books. `recordCharge` writes one row on the database a fenced effect gives it
 * (`SqliteFencedEffectRepository`, #500): synchronously, inside the effect's transaction, so the
 * row and the effect's stored receipt commit together and a step run again replays the receipt
 * instead of charging twice. The ledger keeps no idempotency key and no fencing table of its own.
 */
@Injectable({ deps: [SqliteConnection] })
export class PaymentLedgerRepository {
  constructor(private readonly sqliteConnection: SqliteConnection) {
    sqliteConnection.ensureSchema("payment-charges", SCHEMA);
  }

  /** One charge, written in the effect's transaction; its receipt names the customer and its number. */
  recordCharge(database: DatabaseSync, order: PaymentOrder): Charge {
    const { lastInsertRowid } = database
      .prepare("INSERT INTO payment_charges (customer_id, total) VALUES (?, ?)")
      .run(order.customerId, order.total);
    return { chargeId: `charge-${order.customerId}-${String(lastInsertRowid)}` };
  }

  /** Every charge of a customer, oldest first. */
  chargesOf(customerId: string): readonly PaymentChargeRow[] {
    return this.sqliteConnection.database
      .prepare(
        "SELECT rowid AS chargeNumber, customer_id AS customerId, total " +
          "FROM payment_charges WHERE customer_id = ? ORDER BY rowid",
      )
      .all(customerId)
      .map(chargeRowOf);
  }
}
