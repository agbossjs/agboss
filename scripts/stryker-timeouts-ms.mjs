/**
 * #1367: Stryker's limit for one mutant is `timeoutFactor` x the net time of the tests that cover it +
 * `timeoutMS`; a static mutant, or one every test covers, has the net time of the whole shard, and the net
 * time leaves out hooks and setup (the dry run's "overhead"). A mutant no test kills then outlasted the old
 * limit (1.5 x + 20 s), read as a Timeout, and a Timeout counts as killed: a survivor hid in the score
 * (agbossjs/mongodb#103). The dry run is one worker alone, the mutants run three at once, so a mutant's run
 * takes up to 3 x the dry run's: `timeoutFactor` is 3 (`stryker.config.mjs`) and `timeoutMS` here is 3 x the
 * shard's overhead on CI (the dry run's "overhead" in run 44842888444, 2026-11-21), 60 s at least, so the limit
 * is 3 x the whole run. A Timeout is then a hang: a loop whose guard the mutant took away, and
 * `scripts/stryker-timeouts.mjs` fails a job on one that is not in `scripts/stryker-proven-hangs.mjs`.
 * A hang of an async test stays vitest's (`testTimeout`, `hookTimeout` in every `vitest.mutation*.config.ts`:
 * the test fails, the mutant is Killed). A new shard needs its entry: run it, read "Initial test run succeeded.
 * Ran N tests in X seconds (net Y ms, overhead Z ms)" and set 3 x Z, rounded up to 10 s, 60 s at least.
 */
export const TIMEOUTS_MS = {
  fencing: 200_000,
  "fencing-effects": 240_000,
  "sqlite-stores": 60_000,
  "keys-and-calls": 120_000,
  takeover: 170_000,
  recovery: 180_000,
  undo: 130_000,
  unwind: 200_000,
  money: 150_000,
  spend: 220_000,
  cancel: 170_000,
  "fenced-reach": 60_000,
  pauses: 70_000,
  "pauses-sqlite": 60_000,
  "pause-notices": 180_000,
  "rate-limits": 60_000,
  "money-runtime": 60_000,
  "cancel-stores": 60_000,
  "mesh-charge": 60_000,
  "a2a-tasks": 120_000,
  "a2a-server": 110_000,
  "a2a-client": 60_000,
  "a2a-direct": 60_000,
  stream: 130_000,
  "store-bound": 80_000,
  "a2a-files": 160_000,
  "files-pii": 170_000,
};

/**
 * The `timeoutMS` of `shard`; a shard without an entry fails to load, never runs on a default.
 * @param {string} shard
 * @returns {number}
 */
export function timeoutOf(shard) {
  const ms = TIMEOUTS_MS[shard];
  if (ms === undefined)
    throw new Error(
      `TIMEOUTS_MS (#1367): shard "${shard}" has no entry: set 3 x its dry run's overhead`,
    );
  return ms;
}
