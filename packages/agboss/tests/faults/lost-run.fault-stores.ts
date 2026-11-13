import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { LostRunSqlitePausedExecutionRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #959 negative fixture: the SQLite set whose pause store never keeps a paused run (broken-pause-stores.ts). */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository ? LostRunSqlitePausedExecutionRepository : store,
  ),
};
