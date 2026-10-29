/**
 * #300: a store's `ping()` — every published contract suite (#481) checks that it resolves on both
 * instances; here what only SQLite has: a store whose connection is closed rejects its `ping()`
 * (what `app.checkReadiness()` reports as that store's `Unhealthy`).
 */
import { describe, expect, it } from "vitest";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import type { SqliteConnection } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { SqliteExecutionTreeRepository } from "../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import type { PingedStore } from "../../src/testing/contracts/define.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

/** SQLite stores on one connection (closed by the test). */
function sqliteStoresOn(connection: SqliteConnection): readonly PingedStore[] {
  return [
    new SqliteCostLedgerRepository(connection),
    new SqliteExecutionTreeRepository(connection),
    new SqliteCheckpointSaver(connection),
  ];
}

describe("#300: a SQLite store whose connection is closed", () => {
  it("rejects its ping() with why", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const stores = sqliteStoresOn(connection);
    connection.onDestroy();

    const pinged = await Promise.allSettled(stores.map((store) => store.ping()));

    expect(pinged.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
  });
});
