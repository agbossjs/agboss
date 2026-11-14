import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { OutsideCloseSqlitePausedExecutionRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #940 negative fixture: the SQLite set whose pause store writes an answer's notice outside the answer's transaction. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository ? OutsideCloseSqlitePausedExecutionRepository : store,
  ),
};
