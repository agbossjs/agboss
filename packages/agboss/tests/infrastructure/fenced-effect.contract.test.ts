/**
 * #500 AC3, AC4: the fenced effect — the published fenced-effect contract (`fencedEffectContract`),
 * run against the built-in in-memory store (two instances over one database), once with
 * synchronous business writes and once with writes that wait (the lock per scope, the checks again
 * at commit), and against `SqliteFencedEffectRepository` (two connections to one file).
 */
import { describe } from "vitest";
import { fencedEffectContract } from "../../src/testing/contracts/index.js";
import { inMemoryFencedEffects, sqliteFencedEffects } from "./contracts/fenced-effect-stores.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#500 AC4: the in-memory and SQLite fenced-effect stores pass the published fenced-effect contract", () => {
  fencedEffectContract(inMemoryTarget(inMemoryFencedEffects(false)));
  fencedEffectContract({
    ...inMemoryTarget(inMemoryFencedEffects(true)),
    name: "in-memory, writes that wait",
  });
  fencedEffectContract(sqliteTarget(sqliteFencedEffects));
});
