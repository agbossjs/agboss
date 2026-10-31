import { SqliteFencedEffectRepository } from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";
import { UnfencedSqliteFencedEffectRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #484 negative fixture: the SQLite set with no fencing check on the business write. */
export const faultStores = defineFaultStores({
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteFencedEffectRepository ? UnfencedSqliteFencedEffectRepository : store,
  ),
});
