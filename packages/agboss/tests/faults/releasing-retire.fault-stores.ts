import { BOUNDED_CONTRACTS } from "../../src/infrastructure/contracts.js";
import { SqliteExecutionLeaseRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { ReleasingSqliteExecutionLeaseRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #928: these pods run without the framework's store-call bound. The sabotage freezes a pod whose
 * held ask is then granted the finished child's lease; under load the thawed pod's overdue bound
 * would give that ask up first, and the broken store would not be shown (a timing-dependent case).
 */
BOUNDED_CONTRACTS.clear();

/** #484 negative fixture: the SQLite set whose lease `retire` is a plain `release` (#520). */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionLeaseRepository ? ReleasingSqliteExecutionLeaseRepository : store,
  ),
};
