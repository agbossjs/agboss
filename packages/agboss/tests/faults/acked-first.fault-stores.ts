import { SqlitePausedExecutionRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { AckedBeforeDeliverySqlitePausedExecutionRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #940 negative fixture: the SQLite set whose pause store acknowledges a notice when it claims it, before the receiver was told. */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqlitePausedExecutionRepository
      ? AckedBeforeDeliverySqlitePausedExecutionRepository
      : store,
  ),
};
