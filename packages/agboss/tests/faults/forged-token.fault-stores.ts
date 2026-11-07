import { SqliteFencedEffectRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { ForgedTokenSqliteFencedEffectRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #840 negative fixture: the SQLite set whose business write accepts a token no lease was granted at. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteFencedEffectRepository ? ForgedTokenSqliteFencedEffectRepository : store,
  ),
};
