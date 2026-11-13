import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { LostAnswerSqlitePausedExecutionRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #959 negative fixture: the SQLite set whose `SqlitePausedExecutionRepository` is `LostAnswerSqlitePausedExecutionRepository` (broken-pause-stores.ts). */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository ? LostAnswerSqlitePausedExecutionRepository : store,
  ),
};
