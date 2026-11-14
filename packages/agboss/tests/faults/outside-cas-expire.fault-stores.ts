import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { OutsideCasExpireSqlitePausedExecutionRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #941 negative fixture: the SQLite set whose pause store expires a pause outside the compare-and-set. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository
      ? OutsideCasExpireSqlitePausedExecutionRepository
      : store,
  ),
};
