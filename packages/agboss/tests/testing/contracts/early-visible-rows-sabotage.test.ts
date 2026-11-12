/**
 * #898 AC2 — the "seen by another instance only once the effect committed" case bites: a store
 * whose business row is visible before its effect commits fails it, for a write that is
 * synchronous and one that waits; the same store, sound, passes it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const CASE = "a business row is seen by another instance only once the effect committed";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["early-visible-rows.contract-fixture.ts"]);
}, 120_000);

const stateOf = (target: string) =>
  run.cases.find(
    (found) => found.suites[0] === `fenced effect contract (${target})` && found.name === CASE,
  )?.state;

describe("#898 AC2: a row visible before its effect commits fails the visibility case", () => {
  it.each(["sound, synchronous write", "sound, waiting write"])("%s passes", (target) => {
    expect(stateOf(target)).toBe("pass");
  });

  it.each([
    "visible before the commit, synchronous write",
    "visible before the commit, waiting write",
  ])("%s fails", (target) => {
    expect(stateOf(target)).toBe("fail");
  });
});
