/**
 * #526 AC2 (was #481 AC3, #500 AC4, #501, #505 AC5): the core's in-memory stores — every built-in
 * default, two instances over one `InMemoryDatabase` — pass `storeConformance`: every contract they
 * claim and the store set's cases, as an external store's set runs them. The fenced-effect store
 * also runs with business writes that wait (the lock per scope, the checks again at commit). #533:
 * the interleaving explorer runs on them too, 10 steps deep.
 */
import { describe } from "vitest";
import { fencedEffectContract, storeConformance } from "../../src/testing/contracts/index.js";
import { inMemoryStores } from "./contracts/core-store-sets.js";
import { inMemoryFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

describe("#526 AC2: the core's in-memory stores pass storeConformance", () => {
  // #533: in memory a schedule costs microseconds, so the explorer looks deeper than its default
  storeConformance({ name: "in-memory", stores: inMemoryStores(), interleavings: { depth: 10 } });
  fencedEffectContract({
    ...inMemoryTarget(inMemoryFencedEffects(true)),
    name: "in-memory, writes that wait",
  });
});
