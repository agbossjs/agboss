import process from "node:process";
import type { StoreSet } from "../../../src/testing/contracts/index.js";

/**
 * #1367: the stores whose contract a mutation shard needs of the conformance files; the shard's other
 * contracts take most of the run and kill none of its mutants. It is the file that leaves them out, never
 * the shard's vitest config (`testNamePattern`): vitest keeps a config's pattern as an override of the
 * one Stryker sets for each mutant's covering tests, so every mutant then ran all of the shard's tests
 * (agbossjs/mongodb#103). Every other run, and every other shard, runs the whole set.
 */
const SUBSET: Readonly<Record<string, readonly (keyof StoreSet)[]>> = {
  pauses: ["pausedExecution"],
  "pauses-sqlite": ["pausedExecution"],
  "rate-limits": ["rateLimit"],
};

/** `stores` with the contracts `MUTATION_SHARD` needs, or all of them when it names no such shard. */
export function storesOfShard(
  stores: StoreSet,
  shard: string | undefined = process.env.MUTATION_SHARD,
): StoreSet {
  const keep = shard === undefined ? undefined : SUBSET[shard];
  if (keep === undefined) return stores;
  return Object.fromEntries(
    Object.entries(stores).filter(([key]) => keep.some((kept) => kept === key)),
  );
}

/** Whether `MUTATION_SHARD` names a shard that runs a subset: the file's other suites are left out too. */
export const runsSubset = (shard: string | undefined = process.env.MUTATION_SHARD): boolean =>
  shard !== undefined && shard in SUBSET;
