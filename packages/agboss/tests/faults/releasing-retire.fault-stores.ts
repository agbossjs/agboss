import { SqliteExecutionLeaseRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { ReleasingSqliteExecutionLeaseRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #484 negative fixture: the SQLite set whose lease `retire` is a plain `release` (#520). */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionLeaseRepository ? ReleasingSqliteExecutionLeaseRepository : store,
  ),
};
