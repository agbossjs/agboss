/**
 * #526 AC2 (was #481 AC3, #500 AC4, #501, #505 AC5): the core's in-memory stores — every built-in
 * default, two instances over one `InMemoryDatabase` — pass `storeConformance`: every contract they
 * claim and the store set's cases, as an external store's set runs them. The fenced-effect store
 * also runs with business writes that wait (the lock per scope, the checks again at commit). #533:
 * the interleaving explorer runs on them too, 10 steps deep — 9 in a mutation run (#1242).
 */
import process from "node:process";
import { describe } from "vitest";
import { fencedEffectContract, storeConformance } from "../../src/testing/contracts/index.js";
import { inMemoryStores } from "./contracts/core-store-sets.js";
import { runsSubset, storesOfShard } from "./contracts/mutation-subset.js";
import { inMemoryFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

/**
 * #1242: the depth the explorer looks at. A mutation run reruns this file for each static mutant
 * (a quarter of the fencing shard's), and since #909's cancel action the 10th step costs about 160 s
 * of its 200 s (180,770 schedules per skew in the business-key world, 78,702 at 9): the shards'
 * vitest configs set `AGBOSS_MUTATION_EXPLORER_DEPTH` to 9, every other run looks 10 steps deep.
 */
const depth = Number(process.env.AGBOSS_MUTATION_EXPLORER_DEPTH ?? "10");
if (!Number.isInteger(depth) || depth < 9)
  throw new RangeError(`AGBOSS_MUTATION_EXPLORER_DEPTH: ${String(depth)} is no depth of 9 or more`);

describe("#526 AC2: the core's in-memory stores pass storeConformance", () => {
  // #533: in memory a schedule costs microseconds, so the explorer looks deeper than its default
  storeConformance({
    name: "in-memory",
    stores: storesOfShard(inMemoryStores()),
    interleavings: { depth },
  });
  if (!runsSubset())
    fencedEffectContract({
      ...inMemoryTarget(inMemoryFencedEffects(true)),
      name: "in-memory, writes that wait",
    });
});
