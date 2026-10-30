/**
 * #500 AC3, AC4: the fenced effect — the published fenced-effect contract (`fencedEffectContract`),
 * run against the built-in in-memory store (two instances over one database), once with
 * synchronous business writes and once with writes that wait (the lock per scope, the checks again
 * at commit).
 */
import { describe } from "vitest";
import { fencedEffectContract } from "../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

describe("#500 AC4: the in-memory fenced-effect store passes the published fenced-effect contract", () => {
  fencedEffectContract(inMemoryTarget(inMemoryFencedEffects(false)));
  fencedEffectContract({
    ...inMemoryTarget(inMemoryFencedEffects(true)),
    name: "in-memory, writes that wait",
  });
});
