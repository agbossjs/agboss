import { readFileSync } from "node:fs";
import { Injectable, SqliteConnection } from "@agboss/core";

/** The DDL of the ledger's table, applied once per connection. */
const SCHEMA: string = readFileSync(new URL("../sql/payment-charges.sql", import.meta.url), "utf8");

/** One charge of the ledger: its number, whom it charged and how much (whole dollars). */
export interface PaymentChargeRow {
  readonly chargeNumber: number;
  readonly customerId: string;
  readonly total: number;
}

/** What one charge records: whom, how much, under which idempotency key. */
export interface PaymentChargeRecord {
  readonly idempotencyKey: string;
  readonly customerId: string;
  readonly total: number;
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
 * The offline payment provider's own ledger, in the application's SQLite file — what a real
 * provider keeps on its side. `recordOnce` is the deduplication a provider must make atomically:
 * the insert and the read are one `BEGIN IMMEDIATE` transaction, synchronous, so of two instances
 * (or a crashed one and the one that took over) only one charge is ever made per key.
 */
@Injectable({ deps: [SqliteConnection] })
export class PaymentLedgerRepository {
  constructor(private readonly sqliteConnection: SqliteConnection) {}

  /** The charge under the record's key: made now, or the one an earlier request with that key made. */
  recordOnce(record: PaymentChargeRecord): PaymentChargeRow {
    this.sqliteConnection.ensureSchema("payment-charges", SCHEMA);
    return this.sqliteConnection.transaction(() => {
      const { database } = this.sqliteConnection;
      database
        .prepare(
          "INSERT INTO payment_charges (idempotency_key, customer_id, total) VALUES (?, ?, ?) " +
            "ON CONFLICT (idempotency_key) DO NOTHING",
        )
        .run(record.idempotencyKey, record.customerId, record.total);
      return chargeRowOf(
        database
          .prepare(
            "SELECT rowid AS chargeNumber, customer_id AS customerId, total " +
              "FROM payment_charges WHERE idempotency_key = ?",
          )
          .get(record.idempotencyKey),
      );
    });
  }

  /** Every charge of a customer, oldest first. */
  chargesOf(customerId: string): readonly PaymentChargeRow[] {
    this.sqliteConnection.ensureSchema("payment-charges", SCHEMA);
    return this.sqliteConnection.database
      .prepare(
        "SELECT rowid AS chargeNumber, customer_id AS customerId, total " +
          "FROM payment_charges WHERE customer_id = ? ORDER BY rowid",
      )
      .all(customerId)
      .map(chargeRowOf);
  }
}
