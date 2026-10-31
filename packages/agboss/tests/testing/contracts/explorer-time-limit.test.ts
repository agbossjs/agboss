/**
 * #590: a search that cannot finish in its time limit fails its case with `InterleavingIncompleteError`
 * — how many schedules and states it explored, how many were left, why it stopped — and never
 * passes. The races, which run whole, still pass (explorer-time-limit.contract-fixture.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["explorer-time-limit.contract-fixture.ts"]);
}, 300_000);

describe("#590: the explorer's time limit", () => {
  it("every search case fails with its counts and what was left; no search case passes", () => {
    const searches = run.cases.filter((found) => !found.name.startsWith("AC7"));

    expect(searches.length).toBeGreaterThan(0);
    for (const found of searches) {
      expect(found.state).toBe("fail");
      expect(found.errors[0]).toMatch(
        /stopped after \d+ schedules, \d+ states because it reached its time limit; \d+ left unexplored/u,
      );
    }
  });

  it("the forced races run whole and pass", () => {
    const races = run.cases.filter((found) => found.name.startsWith("AC7"));

    expect(races.length).toBeGreaterThan(0);
    expect(races.every((found) => found.state === "pass")).toBe(true);
  });
});
