/**
 * #261 PR 5 on SQLite (#265 S69 e): the cost ledger counts by budget, scope key and period; a file
 * written before budgets — one counter per workflow and UTC day for `settings().limits` — has that
 * table dropped (no budget reads it) and the budgets' counters start from zero.
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../../src/budgets/budget.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { SqliteCostLedgerRepository } from "../../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { isSqliteImplementation } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const counter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "acme",
  period: "2026-10-18",
};

describe("#261: the SQLite cost ledger of a file written before budgets", () => {
  it("drops the per-workflow day counters and counts by budget from zero", async () => {
    const path = temporarySqlitePath();
    connectionTo(path).database.exec(`CREATE TABLE cost_ledger (
      ledger_key TEXT NOT NULL, utc_day TEXT NOT NULL, spent_usd REAL NOT NULL,
      PRIMARY KEY (ledger_key, utc_day));
      INSERT INTO cost_ledger VALUES ('desk-workflow', '2026-10-18', 0.75);`);

    const ledger = new SqliteCostLedgerRepository(connectionTo(path));
    await ledger.saveAll([counter], [{ costUsd: 0.25 } as UsageRecord]);

    expect(await ledger.findSpentByCounter(counter)).toBe(0.25);
    const columns = connectionTo(path).columnsOf("cost_ledger");
    expect(columns).toEqual(["budget", "scope", "scope_key", "period", "spent_usd"]);
  });

  it("a file already on budgets keeps its counters", async () => {
    const path = temporarySqlitePath();
    await new SqliteCostLedgerRepository(connectionTo(path)).saveAll(
      [counter],
      [{ costUsd: 0.5 } as UsageRecord],
    );

    const reopened = new SqliteCostLedgerRepository(connectionTo(path));

    expect(await reopened.findSpentByCounter(counter)).toBe(0.5);
  });
});

describe("#633: the SQLite cost ledger beyond its contract", () => {
  it("a SQLite implementation that answers its ping", async () => {
    const ledger = new SqliteCostLedgerRepository(connectionTo(temporarySqlitePath()));

    expect(isSqliteImplementation(ledger)).toBe(true);
    await expect(ledger.ping()).resolves.toBeUndefined();
  });

  it("registers its DDL under cost_ledger: the file never runs it again", () => {
    const connection = connectionTo(temporarySqlitePath());
    new SqliteCostLedgerRepository(connection);

    expect(() => {
      connection.ensureSchema("cost_ledger", "NOT A STATEMENT");
    }).not.toThrow();
  });

  it("no calls to count: no row is written", async () => {
    const path = temporarySqlitePath();
    const ledger = new SqliteCostLedgerRepository(connectionTo(path));

    await ledger.saveAll([counter], []);

    const rows = connectionTo(path).database.prepare("SELECT COUNT(*) AS n FROM cost_ledger").get();
    expect(rows).toEqual({ n: 0 });
  });
});
