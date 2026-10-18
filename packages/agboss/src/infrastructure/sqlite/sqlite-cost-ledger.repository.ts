import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import { utcDay } from "../../finops/ledger.js";
import type { UsageRecord } from "../../finops/usage.js";
import { Clock } from "../clock.js";
import { CostLedgerRepository } from "../cost-ledger.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS cost_ledger (
  ledger_key TEXT NOT NULL, utc_day TEXT NOT NULL, spent_usd REAL NOT NULL,
  PRIMARY KEY (ledger_key, utc_day));`;

const SpentRow = z.object({ spent_usd: z.number() });

/**
 * `CostLedgerRepository` on the application's SQLite file (#265, S32): one counter per key and UTC
 * day (the framework clock's day), added to in one `BEGIN IMMEDIATE` transaction, so the instances
 * on one file share the counters and survive a restart. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SqliteCostLedgerRepository extends CostLedgerRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
  ) {
    super();
    connection.ensureSchema("cost_ledger", SCHEMA);
  }

  findSpentToday(key: string): Promise<number> {
    const row = this.connection.database
      .prepare("SELECT spent_usd FROM cost_ledger WHERE ledger_key = ? AND utc_day = ?")
      .get(key, utcDay(this.clock.now()));
    return Promise.resolve(row === undefined ? 0 : SpentRow.parse(row).spent_usd);
  }

  saveAll(key: string, records: readonly UsageRecord[]): Promise<void> {
    const spent = records.reduce((sum, record) => sum + record.costUsd, 0);
    const day = utcDay(this.clock.now());
    this.connection.transaction(() => {
      this.connection.database
        .prepare(
          `INSERT INTO cost_ledger VALUES (?, ?, ?) ON CONFLICT (ledger_key, utc_day)
           DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`,
        )
        .run(key, day, spent);
    });
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteCostLedgerRepository);
