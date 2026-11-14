import { SqliteExecutionTreeRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { CancelBlindSqliteExecutionTreeRepository } from "./broken-a2a-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #811 AC4 negative fixture: the SQLite set whose tree store never reads a cancel request back. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionTreeRepository ? CancelBlindSqliteExecutionTreeRepository : store,
  ),
};
