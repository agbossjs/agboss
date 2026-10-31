import { SqliteOutboundCallRepository } from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";
import { UnfencedSqliteOutboundCallRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #584 negative fixture: the SQLite set with no fencing check on the payment's intent. */
export const faultStores = defineFaultStores({
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteOutboundCallRepository ? UnfencedSqliteOutboundCallRepository : store,
  ),
});
