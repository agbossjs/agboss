/**
 * #261 PR 5 on SQLite (#265 S69 e): the cost ledger counts by budget, scope key and period; a file
 * written before budgets — one counter per workflow and UTC day for `settings().limits` — has that
 * table dropped (no budget reads it) and the budgets' counters start from zero.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

describe("#771: the SQLite cost ledger of a file #727 wrote — its entries without a date", () => {
  /** A file of #727: `cost_ledger_entries` with only the id, one entry held. */
  const fileOf727 = (): string => {
    const path = temporarySqlitePath();
    connectionTo(path).database.exec(`CREATE TABLE cost_ledger_entries (
      ledger_id TEXT NOT NULL PRIMARY KEY);
      INSERT INTO cost_ledger_entries VALUES ('pass-a:0');`);
    return path;
  };
  const entry = (ledgerId: string, madeAt: string): UsageRecord =>
    ({ costUsd: 0.25, ledgerId, madeAt }) as UsageRecord;

  it("dates the held entries never: no prune removes them, a save of one adds nothing", async () => {
    const path = fileOf727();
    const ledger = new SqliteCostLedgerRepository(connectionTo(path));

    await ledger.deleteEntriesByMadeAtBefore(new Date("2030-01-01T00:00:00.000Z"));
    await ledger.saveAll([counter], [entry("pass-a:0", "2026-10-18T08:00:00.000Z")]);

    expect(await ledger.findSpentByCounter(counter)).toBe(0);
    expect(connectionTo(path).columnsOf("cost_ledger_entries")).toEqual(["ledger_id", "made_at"]);
    const held = connectionTo(path)
      .database.prepare("SELECT made_at FROM cost_ledger_entries WHERE ledger_id = 'pass-a:0'")
      .get();
    expect(held).toEqual({ made_at: Number.MAX_SAFE_INTEGER });
  });

  it("indexes the entries by date, for the prune", () => {
    const path = fileOf727();
    new SqliteCostLedgerRepository(connectionTo(path));

    const indexes = connectionTo(path)
      .database.prepare("PRAGMA index_list(cost_ledger_entries)")
      .all()
      .map((row) => z.object({ name: z.string() }).parse(row).name);
    expect(indexes).toContain("cost_ledger_entries_made_at");
  });

  it("an entry made before the mark that it still holds — a save that raced the prune — adds nothing and is not refused", async () => {
    const path = fileOf727();
    const ledger = new SqliteCostLedgerRepository(connectionTo(path));
    await ledger.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));
    connectionTo(path)
      .database.prepare("INSERT INTO cost_ledger_entries VALUES ('pass-c:0', ?)")
      .run(Date.parse("2026-10-18T08:00:00.000Z"));

    await ledger.saveAll([counter], [entry("pass-c:0", "2026-10-18T08:00:00.000Z")]);

    expect(await ledger.findSpentByCounter(counter)).toBe(0);
  });

  it("keeps each new entry with its date, so the sweep's prune reaches it", async () => {
    const path = fileOf727();
    const ledger = new SqliteCostLedgerRepository(connectionTo(path));
    await ledger.saveAll([counter], [entry("pass-b:0", "2026-10-18T08:00:00.000Z")]);

    await ledger.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));

    const rows = connectionTo(path)
      .database.prepare("SELECT ledger_id FROM cost_ledger_entries ORDER BY ledger_id")
      .all();
    expect(rows).toEqual([{ ledger_id: "pass-a:0" }]);
  });
});
