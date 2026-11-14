import { SqliteExecutionLeaseRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { KeepingAgainSqliteExecutionLeaseRepository } from "./broken-a2a-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #811 AC4 negative fixture: the SQLite set whose lease store says "kept" to an id kept before. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionLeaseRepository ? KeepingAgainSqliteExecutionLeaseRepository : store,
  ),
};
