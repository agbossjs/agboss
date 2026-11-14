import { SqliteExecutionLeaseRepository, SqliteExecutionTreeRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { CancelBlindSqliteExecutionTreeRepository } from "./broken-a2a-stores.js";
import { UnmarkedSqliteExecutionLeaseRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #941 negative fixture: the SQLite set where a cancel lands nowhere — the lease store's mark never
 * lands and the tree store never reads the request back. Since #1073 every cancel writes both, so
 * only a set that breaks both shows the scenario's invariant (no effect after a durable cancel).
 */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) => {
    if (store === SqliteExecutionLeaseRepository) return UnmarkedSqliteExecutionLeaseRepository;
    if (store === SqliteExecutionTreeRepository) return CancelBlindSqliteExecutionTreeRepository;
    return store;
  }),
};
