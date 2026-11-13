import { SqliteExecutionRecordRepository } from "../../src/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { ForgetfulMarkSqliteExecutionRecordRepository } from "./broken-pause-stores.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #959 negative fixture: the SQLite set whose `SqliteExecutionRecordRepository` is `ForgetfulMarkSqliteExecutionRecordRepository` (broken-pause-stores.ts). */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionRecordRepository
      ? ForgetfulMarkSqliteExecutionRecordRepository
      : store,
  ),
};
