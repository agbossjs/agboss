import type { DatabaseSync } from "node:sqlite";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  InMemoryFencedEffectRepository,
  type InMemoryFencedEffectTransaction,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import type {
  FencedEffectBusinessRows,
  FencedEffectStores,
} from "../../../src/testing/contracts/index.js";
import { sharedInMemory, type InstanceSeam, type StoreFactory } from "./store-kinds.js";

/**
 * The core's fenced-effect stores as targets of the published fenced-effect contract (#500): one
 * instance's store, the lease store of its database and business rows its writes insert.
 */

type InMemoryRows = FencedEffectBusinessRows<InMemoryFencedEffectTransaction>;

/** Business rows a transaction applies on commit; `isAsync` → each insert waits a turn first. */
function inMemoryRowsOf(committed: string[], isAsync: boolean): InMemoryRows {
  const insert = (transaction: InMemoryFencedEffectTransaction, row: string): void => {
    transaction.onCommit(() => {
      committed.push(row);
    });
  };
  return {
    insert: isAsync
      ? async (transaction, row) => {
          await Promise.resolve();
          insert(transaction, row);
        }
      : insert,
    committed: () => Promise.resolve([...committed]),
  };
}

/** The in-memory store over the test's database; `isAsync` → its writes wait before inserting. */
export const inMemoryFencedEffects =
  (isAsync: boolean): StoreFactory<FencedEffectStores<InMemoryFencedEffectTransaction>> =>
  (seam: InstanceSeam) => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.storeClock,
      seam.application,
      seam.database,
    );
    const settings = new FencedEffectSettings();
    return {
      effects: new InMemoryFencedEffectRepository(seam.storeClock, seam.database, settings, leases),
      leases,
      rows: inMemoryRowsOf(
        sharedInMemory(seam, "fenced-effect-rows", (): string[] => []),
        isAsync,
      ),
    };
  };

/** The business rows of the SQLite target: a table of the test's file, written in the effect's transaction. */
const BUSINESS_ROWS = "CREATE TABLE IF NOT EXISTS contract_rows (row TEXT NOT NULL)";

/** The SQLite store on this instance's connection to the test's file, with its lease store. */
export const sqliteFencedEffects: StoreFactory<FencedEffectStores<DatabaseSync>> = (seam) => {
  const connection = seam.connection();
  connection.ensureSchema("contract_rows", BUSINESS_ROWS);
  return {
    effects: new SqliteFencedEffectRepository(
      connection,
      seam.storeClock,
      new FencedEffectSettings(),
    ),
    leases: new SqliteExecutionLeaseRepository(connection, seam.storeClock, seam.application),
    rows: {
      insert: (database, row) => {
        database.prepare("INSERT INTO contract_rows (row) VALUES (?)").run(row);
      },
      committed: () =>
        Promise.resolve(
          connection.database
            .prepare("SELECT row FROM contract_rows ORDER BY rowid")
            .all()
            .map((found) => String(found.row)),
        ),
    },
  };
};
