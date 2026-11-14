import { BOUNDED_CONTRACTS } from "../../src/infrastructure/contracts.js";
import { SqliteExecutionTreeRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { CancelBlindSqliteExecutionTreeRepository } from "./broken-a2a-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #928: these pods run without the framework's store-call bound. The sabotage models a frozen pod
 * whose held call is answered after the thaw — the thawed start must reach the broken tree store; bounded, the thawed pod gives its call up
 * first (scenarios 17 and 17b then end differently, and pass). The broken store is what is shown here.
 */
BOUNDED_CONTRACTS.clear();

/** #811 AC4 negative fixture: the SQLite set whose tree store never reads a cancel request back. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionTreeRepository ? CancelBlindSqliteExecutionTreeRepository : store,
  ),
};
