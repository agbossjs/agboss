import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { StalePausesSqlitePausedExecutionRepository } from "./broken-a2a-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #811 AC4 negative fixture: the SQLite set whose pause store resolves a withdrawn pause and never
 * drops a paused run.
 */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository ? StalePausesSqlitePausedExecutionRepository : store,
  ),
};
