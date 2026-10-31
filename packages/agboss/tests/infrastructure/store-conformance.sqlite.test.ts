/**
 * #526 AC2 (was #481 AC3, #500 AC4, #501, #505 AC5): the core's SQLite stores — two instances, two
 * connections to one temporary file, so `BEGIN IMMEDIATE` is tested between connections — pass
 * `storeConformance`: every contract they claim and the store set's cases.
 */
import { describe } from "vitest";
import { storeConformance } from "../../src/testing/contracts/index.js";
import { sqliteStores } from "./contracts/core-store-sets.js";

describe("#526 AC2: the core's SQLite stores pass storeConformance", () => {
  storeConformance({ name: "SQLite", stores: sqliteStores() });
});
