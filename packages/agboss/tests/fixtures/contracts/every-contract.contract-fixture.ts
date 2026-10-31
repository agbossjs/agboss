// #481 AC1, #526 AC2: every published suite against one target name, as an outside store's own run
// sees it — through storeConformance, the core's in-memory store set under the name "fixture-store".
import { storeConformance } from "../../../src/testing/contracts/index.js";
import { inMemoryStores } from "../../infrastructure/contracts/core-store-sets.js";

storeConformance({ name: "fixture-store", stores: inMemoryStores() });
