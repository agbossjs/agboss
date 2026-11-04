/**
 * #746 AC1: a pause store that reads back only an approval's ask — as @agboss/postgres and
 * @agboss/mongodb did — fails the paused-execution contract's question cases, and only those: every
 * approval case still passes, so the gap was the contract's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { namesOf, runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const APPROVAL_ONLY = "pauses-approval-only.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([APPROVAL_ONLY]);
}, 120_000);

describe("#746 AC1: a store that keeps only an approval's ask fails the question cases", () => {
  it("fails both question cases and nothing else", () => {
    expect(run.isFailed).toBe(true);
    expect(namesOf(run, APPROVAL_ONLY, "fail")).toEqual([
      "#746: a question's pause is found on the other instance as written — by id and by its tree",
      "#746: a question's pause is sent, answered with the role's answer and taken like any pause",
    ]);
    expect(namesOf(run, APPROVAL_ONLY, "pass").length).toBeGreaterThan(10);
  });
});
