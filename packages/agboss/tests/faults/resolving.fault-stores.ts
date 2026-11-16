import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #1017: the SQLite set declaring that its client's commit retry resolves one lost answer
 * (`resolvesCommitByRetry`), as MongoDB's does. SQLite has no network to cut, so scenarios 23 and
 * 23b skip on it — the declaration reaches the scenarios, which is all the test shows.
 */
export const faultStores: FaultStoreSet = { ...sqlite, resolvesCommitByRetry: true };
