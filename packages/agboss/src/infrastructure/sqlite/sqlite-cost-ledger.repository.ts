import { z } from "zod";
import { BudgetScope } from "../../budgets/budget.js";
import { Injectable } from "../../components/decorators.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { usd, type Usd } from "../../units/index.js";
import {
  CostLedgerRepository,
  type BudgetAccount,
  type CostCounter,
} from "../cost-ledger.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/** One counter per budget, scope key and period; the last `maxSpend()` per budget and scope key. */
const SCHEMA = `CREATE TABLE IF NOT EXISTS cost_ledger (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, period TEXT NOT NULL,
  spent_usd REAL NOT NULL, PRIMARY KEY (budget, scope, scope_key, period));
CREATE TABLE IF NOT EXISTS cost_ledger_max_spend (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, max_spend_usd REAL NOT NULL,
  PRIMARY KEY (budget, scope, scope_key));`;

/**
 * The migration of a file written before budgets (#261 PR 5, #265 S69 e): the old table counted
 * one key (a workflow's name) per UTC day for `settings().limits`, which no budget reads — it is
 * dropped, and the budgets' counters start from zero.
 */
const BUDGETS_MIGRATION = "DROP TABLE cost_ledger;";

const SpentRow = z.object({ spent_usd: z.number() });
const MaxSpendRow = z.object({ max_spend_usd: z.number() });

/** The scope as stored: one of `BudgetScope`'s values. */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

/**
 * `CostLedgerRepository` on the application's SQLite file (#265, S32; counters by budget, #261 PR
 * 5): each call's cost added to every counter in one `BEGIN IMMEDIATE` transaction, so the
 * instances on one file share the counters and survive a restart. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteCostLedgerRepository extends CostLedgerRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.transaction(() => {
      const columns = connection.columnsOf("cost_ledger");
      if (columns.length > 0 && !columns.includes("budget"))
        connection.database.exec(BUDGETS_MIGRATION);
    });
    connection.ensureSchema("cost_ledger", SCHEMA);
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    const row = this.connection.database
      .prepare(
        `SELECT spent_usd FROM cost_ledger
         WHERE budget = ? AND scope = ? AND scope_key = ? AND period = ?`,
      )
      .get(counter.budget, scopeOf(counter), counter.key, counter.period);
    return Promise.resolve(usd(row === undefined ? 0 : SpentRow.parse(row).spent_usd));
  }

  saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    const spent = totalCost(records);
    if (counters.length === 0 || records.length === 0) return Promise.resolve();
    this.connection.transaction(() => {
      const statement = this.connection.database.prepare(
        `INSERT INTO cost_ledger VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (budget, scope, scope_key, period)
         DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`,
      );
      for (const counter of counters)
        statement.run(counter.budget, scopeOf(counter), counter.key, counter.period, spent);
    });
    return Promise.resolve();
  }

  findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    const row = this.connection.database
      .prepare(
        `SELECT max_spend_usd FROM cost_ledger_max_spend
         WHERE budget = ? AND scope = ? AND scope_key = ?`,
      )
      .get(account.budget, scopeOf(account), account.key);
    return Promise.resolve(
      row === undefined ? undefined : usd(MaxSpendRow.parse(row).max_spend_usd),
    );
  }

  saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    this.connection.database
      .prepare("INSERT OR REPLACE INTO cost_ledger_max_spend VALUES (?, ?, ?, ?)")
      .run(account.budget, scopeOf(account), account.key, maxSpend);
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteCostLedgerRepository);
