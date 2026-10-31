/**
 * #526 AC2 (was #481 AC3, #500 AC4, #501, #505 AC5): the core's in-memory stores — every built-in
 * default, two instances over one `InMemoryDatabase` — pass `storeConformance`: every contract they
 * claim and the store set's cases, as an external store's set runs them. The fenced-effect store
 * also runs with business writes that wait (the lock per scope, the checks again at commit).
 */
import { describe } from "vitest";
import { fencedEffectContract, storeConformance } from "../../src/testing/contracts/index.js";
import { inMemoryStores } from "./contracts/core-store-sets.js";
import { inMemoryFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

describe("#526 AC2: the core's in-memory stores pass storeConformance", () => {
  storeConformance({ name: "in-memory", stores: inMemoryStores() });
  fencedEffectContract({
    ...inMemoryTarget(inMemoryFencedEffects(true)),
    name: "in-memory, writes that wait",
  });
});
