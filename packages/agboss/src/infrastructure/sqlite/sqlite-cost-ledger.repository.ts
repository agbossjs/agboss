import { z } from "zod";
import { BudgetScope } from "../../budgets/budget.js";
import { Injectable } from "../../components/decorators.js";
import { totalCost } from "../../finops/usage.js";
import { usd, type Usd } from "../../units/index.js";
import {
  CostLedgerEntryExpiredError,
  CostLedgerRepository,
  expiredEntriesOf,
  invalidLedgerCutoffErrorOf,
  invalidLedgerEntryErrorOf,
  unrecordedEntriesOf,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
} from "../cost-ledger.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/** One counter per budget, scope key and period; the last `maxSpend()` per budget and scope key. */
const SCHEMA = `CREATE TABLE IF NOT EXISTS cost_ledger (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, period TEXT NOT NULL,
  spent_usd REAL NOT NULL, PRIMARY KEY (budget, scope, scope_key, period));
CREATE TABLE IF NOT EXISTS cost_ledger_max_spend (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, max_spend_usd REAL NOT NULL,
  PRIMARY KEY (budget, scope, scope_key));
CREATE TABLE IF NOT EXISTS cost_ledger_entries (
  ledger_id TEXT NOT NULL PRIMARY KEY, made_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cost_ledger_entries_pruned (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), pruned_before INTEGER NOT NULL);`;

/**
 * The entries' date (#771), on a file #727 wrote without it: an entry kept before it is dated
 * "never" — never pruned, never refused (a retry of it made earlier than any cutoff it would get
 * is held) — so pruning cannot reach one whose save may still come; delete those rows by hand once
 * no pass from before the upgrade runs.
 */
const ENTRY_DATE = `INTEGER NOT NULL DEFAULT ${String(Number.MAX_SAFE_INTEGER)}`;

/** The entries by date, for the sweep's prune (after the column exists). */
const ENTRY_DATE_INDEX =
  "CREATE INDEX IF NOT EXISTS cost_ledger_entries_made_at ON cost_ledger_entries (made_at)";

/**
 * The migration of a file written before budgets (#261 PR 5, #265 S69 e): the old table counted
 * one key (a workflow's name) per UTC day for `settings().limits`, which no budget reads — it is
 * dropped, and the budgets' counters start from zero.
 */
const BUDGETS_MIGRATION = "DROP TABLE cost_ledger;";

const SpentRow = z.object({ spent_usd: z.number() });
const MaxSpendRow = z.object({ max_spend_usd: z.number() });
const PrunedRow = z.object({ pruned_before: z.number() });

/** The scope as stored: one of `BudgetScope`'s values. */
const scopeOf = (account: BudgetAccount): string => z.enum(BudgetScope).parse(account.scope);

/**
 * `CostLedgerRepository` on the application's SQLite file (#265, S32; counters by budget, #261 PR
 * 5): each entry's cost added to every counter in one `BEGIN IMMEDIATE` transaction — an entry
 * once by its `ledgerId`, its id kept in `cost_ledger_entries` in that transaction (#727) with its
 * date, pruned by `deleteByMadeAtBefore` under a mark a later save of it is refused by
 * (#771) —, so the
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
    connection.addColumn("cost_ledger_entries", "made_at", ENTRY_DATE);
    connection.transaction(() => {
      connection.database.exec(ENTRY_DATE_INDEX);
    });
  }

  /** The pruning mark (#771, kept in ms): entries made before it may have been removed; none yet → `undefined`. */
  #prunedBefore(): Date | undefined {
    const row = this.connection.database
      .prepare("SELECT pruned_before FROM cost_ledger_entries_pruned WHERE id = 1")
      .get();
    return row === undefined ? undefined : new Date(PrunedRow.parse(row).pruned_before);
  }

  ping(): Promise<void> {
    return this.connection.ping();
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

  saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    // a JS caller's record without an identity is refused before anything (#817)
    const invalid = invalidLedgerEntryErrorOf(entries);
    if (invalid !== undefined) return Promise.reject(invalid);
    if (counters.length === 0 || entries.length === 0) return Promise.resolve();
    // a failure of the file (busy, a row that does not parse) rejects, never throws
    return new Promise<void>((resolve, reject) => {
      const refused = this.#add(counters, entries);
      if (refused === undefined) resolve();
      else reject(refused);
    });
  }

  /** Adds `entries` to every counter in one transaction, or answers why it refused them (#771). */
  #add(
    counters: readonly CostCounter[],
    entries: readonly LedgerEntry[],
  ): CostLedgerEntryExpiredError | undefined {
    let refused: CostLedgerEntryExpiredError | undefined;
    this.connection.transaction(() => {
      // an entry it may have pruned is refused, the whole save with it (#771): the mark is read
      // in the transaction a prune's is written in, one writer at a time on the file
      const prunedBefore = this.#prunedBefore();
      const held = this.connection.database.prepare(
        "SELECT 1 FROM cost_ledger_entries WHERE ledger_id = ?",
      );
      const expired = expiredEntriesOf(entries, prunedBefore, (id) => held.get(id) !== undefined);
      // Stryker disable next-line ConditionalExpression: an expired entry needs a mark — `expiredEntriesOf` names none without one; the check only narrows its type
      if (expired.length > 0 && prunedBefore !== undefined) {
        refused = new CostLedgerEntryExpiredError({ ledgerIds: expired, prunedBefore });
        return;
      }
      // each entry once (#727): its id kept, with its date, in the transaction that adds its cost
      const entry = this.connection.database.prepare(
        "INSERT INTO cost_ledger_entries VALUES (?, ?) ON CONFLICT (ledger_id) DO NOTHING",
      );
      const added = unrecordedEntriesOf(
        entries,
        (id, madeAt) => entry.run(id, madeAt.getTime()).changes === 1,
      );
      const spent = totalCost(added);
      const statement = this.connection.database.prepare(
        `INSERT INTO cost_ledger VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (budget, scope, scope_key, period)
         DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`,
      );
      for (const counter of counters)
        statement.run(counter.budget, scopeOf(counter), counter.key, counter.period, spent);
    });
    return refused;
  }

  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    // a cutoff that is no date would lower the mark: refused with the ledger's code (#817, #869)
    const refused = invalidLedgerCutoffErrorOf(cutoff);
    if (refused !== undefined) return Promise.reject(refused);
    this.connection.transaction(() => {
      const kept = this.#prunedBefore()?.getTime() ?? Number.NEGATIVE_INFINITY;
      const prunedBefore = Math.max(kept, cutoff.getTime());
      this.connection.database
        .prepare(
          `INSERT INTO cost_ledger_entries_pruned VALUES (1, ?)
           ON CONFLICT (id) DO UPDATE SET pruned_before = excluded.pruned_before`,
        )
        .run(prunedBefore);
      this.connection.database
        .prepare("DELETE FROM cost_ledger_entries WHERE made_at < ?")
        .run(prunedBefore);
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
