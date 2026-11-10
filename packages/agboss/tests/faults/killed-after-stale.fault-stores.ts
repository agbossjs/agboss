import { SqliteFencedEffectRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { KilledAfterStaleSqliteFencedEffectRepository } from "./broken-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #876 negative fixture: the SQLite set whose business write lets a stale token through and kills
 * its pod before the answer.
 */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteFencedEffectRepository ? KilledAfterStaleSqliteFencedEffectRepository : store,
  ),
};
