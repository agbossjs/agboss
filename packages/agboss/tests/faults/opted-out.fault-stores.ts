import { SqliteFencedEffectRepository } from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";
import { OptedOutSqliteFencedEffectRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #584 negative fixture: the SQLite set whose fenced-effect store declares the opt-out. */
export const faultStores = defineFaultStores({
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteFencedEffectRepository ? OptedOutSqliteFencedEffectRepository : store,
  ),
});
