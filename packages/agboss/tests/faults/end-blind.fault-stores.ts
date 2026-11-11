import { SqliteExecutionRecordRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { EndBlindSqliteExecutionRecordRepository } from "./broken-a2a-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #901 negative fixture: the SQLite set whose record store reads a failed root by its run id as
 * still running — the resume's check at its take sees no end, as a core without it would.
 */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionRecordRepository ? EndBlindSqliteExecutionRecordRepository : store,
  ),
};
