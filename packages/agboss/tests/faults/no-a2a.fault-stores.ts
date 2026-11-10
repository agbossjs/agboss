import { SqliteA2ATaskRepository } from "../../src/a2a/index.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #811 AC4: the SQLite set without its A2A task store — a set like the external ones' that keep no
 * A2A tasks: its pods serve no A2A, and the A2A scenarios are skipped with the reason.
 */
export const faultStores: FaultStoreSet = {
  ...sqlite,
  providers: sqlite.providers.filter((store) => store !== SqliteA2ATaskRepository),
};
