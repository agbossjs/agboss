import { SqliteExecutionLeaseRepository } from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";
import { StaleRenewingSqliteExecutionLeaseRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #608 negative fixture: the SQLite set whose lease renewal says yes to a lease that is over. */
export const faultStores = defineFaultStores({
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionLeaseRepository ? StaleRenewingSqliteExecutionLeaseRepository : store,
  ),
});
