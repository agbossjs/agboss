/**
 * #807 AC4 — the A2A task contract bites: the sound in-memory store passes every case, and a store
 * broken one way fails the cases of its rule — a check-then-write accept, a compare-and-set that
 * ignores the version or writes over a terminal status, an unsorted list, a sweep of unfinished
 * tasks, message ids shared across owners.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["a2a-task-bites.contract-fixture.ts"]);
}, 120_000);

const casesOf = (target: string) =>
  run.cases.filter((found) => found.suites[0] === `A2A task contract (${target})`);

const failedOf = (target: string): readonly string[] =>
  casesOf(target)
    .filter((found) => found.state === "fail")
    .map((found) => found.name);

describe("#807 AC4: a task store that breaks a rule fails the A2A task contract", () => {
  it("the sound store passes every case (23)", () => {
    expect(casesOf("sound").map((found) => found.state)).toEqual(Array(23).fill("pass"));
  });

  it.each([
    ["checks then writes", "one message is accepted once, on two instances"],
    ["ignores the version", "a status is written at the expected version only"],
    ["overwrites a terminal status", "a terminal status is sticky"],
    ["overwrites a terminal status", "a task saved rejected is terminal from the start"],
    ["lists unsorted", "a caller's tasks, the newest status first"],
    ["lists unsorted", "pages follow each other"],
    ["sweeps unfinished tasks", "the sweep removes terminal tasks older than its cutoff"],
    ["shares message ids across owners", "a message id is its tenant's and its owner's"],
  ])("a store that %s fails %j", (target, rule) => {
    expect(failedOf(target).some((name) => name.startsWith(rule))).toBe(true);
  });
});
